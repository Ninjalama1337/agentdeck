/**
 * JSON-file persistence layer.
 *
 * - Registries (projects, devices, teams) are atomic JSON files under dataDir.
 * - Sessions live in `sessions/<id>/meta.json` (+ optional source) with an
 *   append-only `messages.jsonl`.
 * - All mutations go through a per-key promise mutex; consumers subscribe via
 *   `onChange` (wired to socket.io broadcasts by the app layer).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Account, ChatMessage, DeviceInfo, Project, Routine, Session, TeamRun } from '@agentdeck/shared';
import { ensureDir } from '../util/paths.js';
import { newAccountId, newDeviceId, newMessageId, newRoutineId, newSessionId } from '../util/ids.js';

export type MessageSource = NonNullable<ChatMessage['source']>

export type StoreChange =
  | { kind: 'project'; project: Project }
  | { kind: 'project-deleted'; id: string }
  | { kind: 'session'; session: Session }
  | { kind: 'session-deleted'; id: string }
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'team'; run: TeamRun }
  | { kind: 'routine'; routine: Routine }
  | { kind: 'routine-deleted'; id: string }
  | { kind: 'account'; account: Account }
  | { kind: 'account-deleted'; id: string }
  | { kind: 'device'; device: DeviceInfo };

export type ChangeHandler = (change: StoreChange) => void;

interface SessionMetaFile {
  session: Session;
  source?: MessageSource;
}

export class Store {
  private readonly dataDir: string;
  private readonly sessionsDir: string;
  private readonly attachmentsDir: string;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly handlers = new Set<ChangeHandler>();

  private projects = new Map<string, Project>();
  private devices = new Map<string, DeviceInfo>();
  private teams = new Map<string, TeamRun>();
  private routines = new Map<string, Routine>();
  private accounts = new Map<string, Account>();
  private sessions = new Map<string, Session>();
  private sessionSources = new Map<string, MessageSource>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.sessionsDir = path.join(dataDir, 'sessions');
    this.attachmentsDir = path.join(dataDir, 'attachments');
  }

  /** Loads persisted registries; call once during startup. */
  async init(): Promise<void> {
    await Promise.all([
      ensureDir(this.dataDir),
      ensureDir(this.sessionsDir),
      ensureDir(this.attachmentsDir),
    ]);
    this.projects = await this.loadRegistry<Project>('projects.json');
    this.devices = await this.loadRegistry<DeviceInfo>('devices.json');
    this.teams = await this.loadRegistry<TeamRun>('teams.json');
    this.routines = await this.loadRegistry<Routine>('routines.json');
    this.accounts = await this.loadRegistry<Account>('accounts.json');
    this.sessionSources.clear();
    await this.loadSessions();
  }

  /** Rehydrates all persisted sessions (meta.json) into the cache. */
  private async loadSessions(): Promise<void> {
    let ids: string[];
    try {
      ids = await fsp.readdir(this.sessionsDir);
    } catch {
      return;
    }
    await Promise.all(
      ids.map(async (id) => {
        try {
          const raw = await fsp.readFile(path.join(this.sessionsDir, id, 'meta.json'), 'utf8');
          const meta = JSON.parse(raw) as SessionMetaFile;
          if (meta?.session?.id) {
            this.sessions.set(meta.session.id, meta.session);
            if (meta.source) this.sessionSources.set(meta.session.id, meta.source);
            await this.recoverInterrupted(meta.session);
          }
        } catch {
          // Skip unreadable session dirs.
        }
      }),
    );
  }

  /**
   * A run cannot outlive the server process. A session still marked running or
   * queued at startup lost its turn (restart, crash) — without this it would
   * show "working" forever and refuse new messages.
   */
  private async recoverInterrupted(session: Session): Promise<void> {
    if (session.status !== 'running' && session.status !== 'queued') return;
    session.status = 'idle';
    // The in-memory queue did not survive the restart either.
    session.queuedCount = undefined;
    await this.appendMessage({
      id: newMessageId(),
      sessionId: session.id,
      role: 'system',
      agentId: session.agentId,
      text: 'The server restarted while this run was active — the answer was lost. Send your message again.',
      attachments: [],
      ts: Date.now(),
    });
    await this.saveSession(session);
  }

  onChange(handler: ChangeHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(change: StoreChange): void {
    for (const handler of this.handlers) {
      try {
        handler(change);
      } catch {
        // A broken subscriber must never break persistence.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Low-level helpers
  // -------------------------------------------------------------------------

  private async loadRegistry<T>(file: string): Promise<Map<string, T>> {
    const map = new Map<string, T>();
    try {
      const raw = await fsp.readFile(path.join(this.dataDir, file), 'utf8');
      const parsed = JSON.parse(raw) as (T & { id: string })[];
      if (Array.isArray(parsed)) {
        for (const item of parsed) map.set(item.id, item);
      }
    } catch {
      // Missing or unreadable file → start empty.
    }
    return map;
  }

  private async writeRegistry(file: string, values: Iterable<unknown>): Promise<void> {
    await this.writeJsonAtomic(path.join(this.dataDir, file), [...values]);
  }

  private async writeJsonAtomic(file: string, data: unknown): Promise<void> {
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tmp, file);
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.locks.set(
      key,
      run.catch(() => undefined),
    );
    return run;
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  listProjects(): Project[] {
    return [...this.projects.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getProject(id: string): Project | undefined {
    return this.projects.get(id);
  }

  findProjectByNameOrId(idOrName: string): Project | undefined {
    return this.projects.get(idOrName) ?? this.listProjects().find((p) => p.name === idOrName);
  }

  async saveProject(project: Project, opts: { touch?: boolean } = {}): Promise<Project> {
    const next: Project = {
      ...project,
      updatedAt: opts.touch === false ? project.updatedAt : Date.now(),
    };
    this.projects.set(next.id, next);
    await this.withLock('registry:projects', () =>
      this.writeRegistry('projects.json', this.projects.values()),
    );
    this.emit({ kind: 'project', project: next });
    return next;
  }

  async deleteProject(id: string): Promise<boolean> {
    if (!this.projects.delete(id)) return false;
    await this.withLock('registry:projects', () =>
      this.writeRegistry('projects.json', this.projects.values()),
    );
    this.emit({ kind: 'project-deleted', id });
    return true;
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  listDevices(): DeviceInfo[] {
    return [...this.devices.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getDevice(id: string): DeviceInfo | undefined {
    return this.devices.get(id);
  }

  async saveDevice(device: DeviceInfo): Promise<DeviceInfo> {
    this.devices.set(device.id, device);
    await this.withLock('registry:devices', () =>
      this.writeRegistry('devices.json', this.devices.values()),
    );
    this.emit({ kind: 'device', device });
    return device;
  }

  async deleteDevice(id: string): Promise<boolean> {
    if (!this.devices.delete(id)) return false;
    await this.withLock('registry:devices', () =>
      this.writeRegistry('devices.json', this.devices.values()),
    );
    return true;
  }

  async registerDevice(name: string): Promise<DeviceInfo> {
    const device: DeviceInfo = {
      id: newDeviceId(),
      name: name.trim() || 'Device',
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    await this.saveDevice(device);
    return device;
  }

  async touchDevice(id: string): Promise<void> {
    const device = this.devices.get(id);
    if (!device) return;
    device.lastSeenAt = Date.now();
    await this.withLock('registry:devices', () =>
      this.writeRegistry('devices.json', this.devices.values()),
    );
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  listSessions(projectId?: string): Session[] {
    const all = [...this.sessions.values()];
    const filtered = projectId ? all.filter((s) => s.projectId === projectId) : all;
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getSessionSource(id: string): MessageSource | undefined {
    return this.sessionSources.get(id);
  }

  async createSession(session: Session, source?: MessageSource): Promise<Session> {
    await this.saveSession(session, source);
    return session;
  }

  async newSession(
    init: Pick<Session, 'projectId' | 'agentId'> &
      Partial<Pick<Session, 'title' | 'model' | 'thinkingEffort' | 'permissionMode' | 'accountId'>>,
    source?: MessageSource,
  ): Promise<Session> {
    const now = Date.now();
    const session: Session = {
      id: newSessionId(),
      projectId: init.projectId,
      agentId: init.agentId,
      title: init.title ?? 'New session',
      status: 'idle',
      model: init.model,
      ...(init.thinkingEffort !== undefined ? { thinkingEffort: init.thinkingEffort } : {}),
      ...(init.accountId !== undefined ? { accountId: init.accountId } : {}),
      permissionMode: init.permissionMode ?? 'default',
      createdAt: now,
      updatedAt: now,
    };
    await this.saveSession(session, source);
    return session;
  }

  async saveSession(session: Session, source?: MessageSource): Promise<Session> {
    const next: Session = { ...session, updatedAt: Math.max(session.updatedAt, Date.now()) };
    if (source !== undefined) this.sessionSources.set(next.id, source);
    this.sessions.set(next.id, next);
    const meta: SessionMetaFile = {
      session: next,
      ...(this.sessionSources.get(next.id) ? { source: this.sessionSources.get(next.id) } : {}),
    };
    await this.withLock(`meta:${next.id}`, async () => {
      await ensureDir(this.sessionDir(next.id));
      await this.writeJsonAtomic(path.join(this.sessionDir(next.id), 'meta.json'), meta);
    });
    this.emit({ kind: 'session', session: next });
    return next;
  }

  async deleteSession(id: string): Promise<boolean> {
    if (!this.sessions.has(id)) return false;
    this.sessions.delete(id);
    this.sessionSources.delete(id);
    await this.withLock(`meta:${id}`, async () => {
      await fsp.rm(this.sessionDir(id), { recursive: true, force: true });
    });
    this.emit({ kind: 'session-deleted', id });
    return true;
  }

  private sessionDir(id: string): string {
    return path.join(this.sessionsDir, id);
  }

  attachmentsDirFor(sessionId: string): string {
    return path.join(this.attachmentsDir, sessionId);
  }

  /** Root of all session attachments (sandbox root for attachment downloads). */
  get attachmentsRoot(): string {
    return this.attachmentsDir;
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async appendMessage(message: ChatMessage): Promise<ChatMessage> {
    await this.withLock(`messages:${message.sessionId}`, async () => {
      await ensureDir(this.sessionDir(message.sessionId));
      await fsp.appendFile(
        this.messagesFile(message.sessionId),
        JSON.stringify(message) + '\n',
        'utf8',
      );
    });
    this.emit({ kind: 'message', message });
    return message;
  }

  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.messagesFile(sessionId), 'utf8');
    } catch {
      return [];
    }
    const messages: ChatMessage[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        messages.push(JSON.parse(trimmed) as ChatMessage);
      } catch {
        // Skip torn/corrupt lines instead of failing the whole history.
      }
    }
    return messages.sort((a, b) => a.ts - b.ts);
  }

  private messagesFile(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'messages.jsonl');
  }

  /**
   * Locates an uploaded attachment by id: `<fileId>__<safe-name>` inside the
   * session attachments dir, falling back to project-scope uploads.
   */
  async findAttachment(
    session: Session,
    project: Project,
    fileId: string,
  ): Promise<{ absPath: string; name: string } | undefined> {
    const candidates: string[] = [this.attachmentsDirFor(session.id), path.join(project.path, 'uploads'), project.path];
    for (const dir of candidates) {
      let entries: string[];
      try {
        entries = await fsp.readdir(dir);
      } catch {
        continue;
      }
      const match = entries.find((e) => e.startsWith(`${fileId}__`));
      if (match) {
        const name = match.slice(`${fileId}__`.length);
        return { absPath: path.join(dir, match), name };
      }
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Team runs
  // -------------------------------------------------------------------------

  listTeams(projectId?: string): TeamRun[] {
    const all = [...this.teams.values()];
    const filtered = projectId ? all.filter((t) => t.projectId === projectId) : all;
    return filtered.sort((a, b) => b.createdAt - a.createdAt);
  }

  getTeam(id: string): TeamRun | undefined {
    return this.teams.get(id);
  }

  async saveTeam(run: TeamRun): Promise<TeamRun> {
    const next: TeamRun = { ...run, updatedAt: Date.now() };
    this.teams.set(next.id, next);
    await this.withLock('registry:teams', () => this.writeRegistry('teams.json', this.teams.values()));
    this.emit({ kind: 'team', run: next });
    return next;
  }

  // -------------------------------------------------------------------------
  // Routines (agents on recurring jobs)
  // -------------------------------------------------------------------------

  listRoutines(projectId?: string): Routine[] {
    const all = [...this.routines.values()];
    const filtered = projectId ? all.filter((r) => r.projectId === projectId) : all;
    return filtered.sort((a, b) => b.createdAt - a.createdAt);
  }

  getRoutine(id: string): Routine | undefined {
    return this.routines.get(id);
  }

  async saveRoutine(routine: Routine): Promise<Routine> {
    const next: Routine = { ...routine, updatedAt: Date.now() };
    this.routines.set(next.id, next);
    await this.withLock('registry:routines', () =>
      this.writeRegistry('routines.json', this.routines.values()),
    );
    this.emit({ kind: 'routine', routine: next });
    return next;
  }

  async deleteRoutine(id: string): Promise<boolean> {
    if (!this.routines.delete(id)) return false;
    await this.withLock('registry:routines', () =>
      this.writeRegistry('routines.json', this.routines.values()),
    );
    this.emit({ kind: 'routine-deleted', id });
    return true;
  }

  newRoutineId(): string {
    return newRoutineId();
  }

  // -------------------------------------------------------------------------
  // Accounts (env profiles per agent)
  // -------------------------------------------------------------------------

  listAccounts(agentId?: string): Account[] {
    const all = [...this.accounts.values()];
    const filtered = agentId ? all.filter((a) => a.agentId === agentId) : all;
    return filtered.sort((a, b) => b.createdAt - a.createdAt);
  }

  getAccount(id: string): Account | undefined {
    return this.accounts.get(id);
  }

  async saveAccount(account: Account): Promise<Account> {
    this.accounts.set(account.id, account);
    await this.withLock('registry:accounts', () =>
      this.writeRegistry('accounts.json', this.accounts.values()),
    );
    this.emit({ kind: 'account', account });
    return account;
  }

  async deleteAccount(id: string): Promise<boolean> {
    if (!this.accounts.delete(id)) return false;
    await this.withLock('registry:accounts', () =>
      this.writeRegistry('accounts.json', this.accounts.values()),
    );
    this.emit({ kind: 'account-deleted', id });
    return true;
  }

  newAccountId(): string {
    return newAccountId();
  }
}

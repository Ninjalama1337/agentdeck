/**
 * Fastify app factory: CORS, multipart, static SPA serving, auth hook,
 * socket.io gateway, store→WS broadcast wiring, error shaping.
 */
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
} from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import { ZodError } from 'zod';
import type { DeckNotificationState, PermissionRequest } from '@agentdeck/shared';
import type { Config } from '../config.js';
import { createLogger, type Logger } from '../logging.js';
import { Store } from '../state/store.js';
import { AgentService } from '../agents/registry.js';
import { AgentManager } from '../agents/manager.js';
import { TeamOrchestrator } from '../team/orchestrator.js';
import { PairingCodeManager, loadOrCreateSecret } from '../auth/secrets.js';
import { AttemptLimiter } from '../auth/attemptLimiter.js';
import { PairRequests } from '../auth/pairRequests.js';
import { makeBridgeGuard, makeDeviceAuthHook } from '../auth/guards.js';
import { TunnelManager } from '../tunnel/manager.js';
import { UsageCollector } from '../usage/collector.js';
import { alertText, UsageWatcher } from '../usage/watcher.js';
import { WorktreeStore } from '../git/worktrees.js';
import { KeepAwake } from '../power/keepAwake.js';
import { PreviewProxy } from '../preview/proxy.js';
import { ActiveAccounts } from '../accounts/active.js';
import { AdminJobRunner } from '../admin/runner.js';
import { RateLimiter } from '../util/rateLimit.js';
import { attachGateway, makeBroadcaster, type Broadcaster, type DeckIo } from '../ws/gateway.js';
import { FileWatchers } from '../files/watcher.js';
import { TerminalManager, type TerminalTurn } from '../term/manager.js';
import { RoutineScheduler } from '../routines/scheduler.js';
import { NotificationHub, stateTitle, summarize } from '../notify/hub.js';
import { classifyReply, isLimitError } from '../notify/classify.js';
import { VoiceService } from '../voice/transcribe.js';
import { registerRoutes } from '../routes/index.js';
import { terminalBroadcasts } from '../routes/terminals.js';
import type { AppDeps } from '../routes/deps.js';
import { NAME, PACKAGED, REPO_ROOT, VERSION } from '../version.js';
import { StatsDb } from '../stats/db.js';
import { readClaudeTurn } from '../stats/claudeTranscript.js';
import { newId } from '../util/ids.js';
import { UpdateManager } from '../update/manager.js';
import { findWebDist } from './webDist.js';

const gzip = promisify(zlib.gzip);
/** Smaller answers are not worth compressing. */
const GZIP_MIN_CHARS = 1024;

const FALLBACK_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentDeck</title>
<style>body{font-family:system-ui,sans-serif;background:#0e1116;color:#e6e8eb;display:grid;place-items:center;height:100vh;margin:0}
main{text-align:center;max-width:34rem;padding:2rem}code{background:#1c2230;padding:.15em .4em;border-radius:.3em}</style></head>
<body><main><h1>🃏 AgentDeck API is running.</h1>
<p>The web UI is not built yet. Run <code>npm run build -w web</code> and reload.</p>
<p>REST API under <code>/api</code> · WebSocket under <code>/socket.io</code></p></main></body></html>`;

export { findWebDist };

export interface BuiltApp {
  app: FastifyInstance;
  io: DeckIo;
  deps: AppDeps;
  store: Store;
  agents: AgentService;
  manager: AgentManager;
  tunnel: TunnelManager;
  adminJobs: AdminJobRunner;
  logger: Logger;
}

export async function buildApp(config: Config): Promise<BuiltApp> {
  const log = createLogger(config.logLevel);
  const store = new Store(config.dataDir);
  await store.init();

  const agents = new AgentService(config, log);
  const jwtSecret = await loadOrCreateSecret(config.dataDir, 'jwt-secret');
  const bridgeToken = await loadOrCreateSecret(config.dataDir, 'bridge-token');
  const pairing = new PairingCodeManager(config.dataDir);
  const pairingCode = await pairing.readOrCreate();
  const limiter = new AttemptLimiter();

  const app = fastify({
    // Our pino instance satisfies the FastifyBaseLogger surface.
    loggerInstance: log as unknown as FastifyBaseLogger,
    bodyLimit: Math.max(config.maxUploadBytes * 2, 4 * 1024 * 1024),
  });

  await app.register(cors, { origin: config.corsOrigins, credentials: true });
  await app.register(multipart, {
    limits: { files: 1, fileSize: config.maxUploadBytes },
  });

  // Static web app (SPA) when built.
  const webDist = findWebDist();
  if (webDist) {
    await app.register(staticFiles, { root: webDist });
    log.info({ webDist }, 'serving web app');
  }

  // Broadcast plumbing: store/entity changes → WS; adapter events → WS.
  let broadcast: Broadcaster = () => undefined;
  const notifications = new NotificationHub({
    dataDir: config.dataDir,
    log,
    broadcast: (notification) => broadcast('notification', { notification }),
  });
  await notifications.init();
  const stats = await StatsDb.open(StatsDb.fileIn(config.dataDir), log);
  const manager = new AgentManager(
    config,
    store,
    agents,
    log,
    (sessionId, event, meta) => {
      broadcast('session:event', { sessionId, ts: Date.now(), event, ...meta });
      if (event.type === 'status' && (event.status === 'idle' || event.status === 'error')) {
        void notifySessionFinished(sessionId, event.status);
      } else if (event.type === 'permission-request') {
        notifyPermission(sessionId, event.request);
      }
    },
    (run) => stats.recordRun(run),
  );

  /** A turn of an agent TUI goes on record; Claude Code's with what its transcript says it used. */
  async function recordTerminalTurn(turn: TerminalTurn): Promise<void> {
    try {
      const used = turn.transcriptPath ? await readClaudeTurn(turn.transcriptPath, turn.startedAt) : undefined;
      const { toolCalls, model, ...usage } = used ?? { toolCalls: undefined, model: undefined };
      stats.recordRun({
        id: newId('run'),
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
        // Only Claude Code reports through hooks with a transcript.
        agentId: turn.transcriptPath ? 'claude' : (turn.info.presetId ?? 'terminal'),
        ...(model ? { model } : {}),
        projectId: turn.info.projectId,
        ...(store.getProject(turn.info.projectId) ? { projectName: store.getProject(turn.info.projectId)?.name } : {}),
        terminalId: turn.info.id,
        source: 'terminal',
        status: turn.state === 'done' ? 'ok' : 'error',
        ...(turn.state !== 'done' && turn.detail ? { error: turn.detail } : {}),
        ...(turn.prompt ? { title: turn.prompt } : {}),
        ...(turn.state === 'done' && turn.detail ? { summary: turn.detail } : {}),
        ...usage,
        ...(toolCalls !== undefined ? { toolCalls } : {}),
      });
    } catch (err) {
      log.warn({ err }, 'could not record terminal turn');
    }
  }

  /** The run stopped to ask → inbox + push, with Allow / Deny on the notification. */
  function notifyPermission(sessionId: string, request: PermissionRequest): void {
    const session = store.getSession(sessionId);
    if (!session) return;
    const project = store.getProject(session.projectId);
    const label = agents.infoOf(session.agentId)?.label ?? session.agentId;
    const question = request.questions?.[0]?.question;
    notifications.notify({
      kind: 'session-permission',
      state: 'waiting',
      title: stateTitle('waiting', label, project?.name ?? 'project'),
      body: summarize(question ?? `${request.tool}: ${request.summary ?? 'wants to run'}`),
      projectId: session.projectId,
      sessionId,
      // A question with options is answered in the app, not with two buttons.
      ...(question ? {} : { permissionId: request.id }),
    });
  }

  /** Run finished → inbox + push ("Claude is done in winterlicht"). */
  async function notifySessionFinished(sessionId: string, status: 'idle' | 'error'): Promise<void> {
    try {
      const session = store.getSession(sessionId);
      if (!session) return;
      // Team steps report once per run (below), not per step.
      if (store.getSessionSource(sessionId) === 'team') return;
      const project = store.getProject(session.projectId);
      const label = agents.infoOf(session.agentId)?.label ?? session.agentId;
      const where = project?.name ?? 'project';
      let state: DeckNotificationState;
      let body: string;
      if (status === 'error') {
        state = isLimitError(session.lastError) ? 'limit' : 'error';
        body = summarize(session.lastError) || 'The run failed.';
      } else {
        const messages = await store.getMessages(sessionId);
        const last = [...messages].reverse().find((m) => m.role === 'assistant');
        state = classifyReply(last?.text).state;
        body = summarize(last?.text) || 'Finished.';
      }
      notifications.notify({
        kind: status === 'error' ? 'session-error' : 'session-done',
        state,
        title: stateTitle(state, label, where),
        body,
        projectId: session.projectId,
        sessionId,
      });
    } catch (err) {
      log.warn({ err }, 'session notification failed');
    }
  }
  const notifiedTeams = new Set<string>();
  // PTY terminals — broadcast callbacks are built per call in the routes
  // (they close over `deps.broadcast`, which is bound by then).
  const terminals = new TerminalManager(log, {
    dataDir: config.dataDir,
    serverPort: config.port,
    serverPid: process.pid,
    hookToken: bridgeToken,
    onTurn: (turn) => void recordTerminalTurn(turn),
  });
  const routines = new RoutineScheduler({ store, manager, log });
  const io = attachGateway({
    httpServer: app.server,
    secretHex: jwtSecret,
    logger: log,
    manager,
    terminals,
    onTerminalSeen: (id) => terminals.markSeen(id, terminalBroadcasts(deps)),
    touchDevice: (deviceId) => store.touchDevice(deviceId),
    corsOrigins: config.corsOrigins,
  });
  broadcast = makeBroadcaster(io);

  // Live file watcher: one recursive fs.watch per project, batched into
  // `files:changed` (API writes join the same stream — see filesEdit routes).
  const fileWatchers = new FileWatchers({ broadcast, log });

  store.onChange((change) => {
    switch (change.kind) {
      case 'project':
        broadcast('project:update', { project: change.project });
        break;
      case 'session':
        broadcast('session:update', { session: change.session });
        break;
      case 'message':
        broadcast('session:event', {
          sessionId: change.message.sessionId,
          ts: change.message.ts,
          event: { type: 'message', message: change.message },
        });
        break;
      case 'team':
        broadcast('team:update', { run: change.run });
        if ((change.run.status === 'done' || change.run.status === 'error') && !notifiedTeams.has(change.run.id)) {
          notifiedTeams.add(change.run.id);
          const project = store.getProject(change.run.projectId);
          const steps = change.run.steps.length;
          const state = change.run.status === 'done' ? 'done' : 'error';
          notifications.notify({
            kind: state === 'done' ? 'team-done' : 'team-error',
            state,
            title: stateTitle(state, 'Team run', project?.name ?? 'project'),
            body: `${steps} ${steps === 1 ? 'step' : 'steps'} — tap to review`,
            projectId: change.run.projectId,
            runId: change.run.id,
          });
        }
        break;
      case 'routine':
        broadcast('routine:update', { routine: change.routine });
        break;
      case 'routine-deleted':
        broadcast('routine:deleted', { id: change.id });
        break;
      case 'account':
      case 'account-deleted':
        break; // accounts are static profiles — clients refetch on demand
      case 'session-deleted':
        broadcast('notify', { level: 'info', text: 'Session deleted.' });
        break;
      case 'project-deleted':
        fileWatchers.stop(change.id); // no watcher for a deregistered project
        broadcast('notify', { level: 'info', text: 'Project removed.' });
        break;
      case 'device':
        break; // no device broadcast in the WS contract
    }
  });

  agents.onInfo((info) => broadcast('agent:update', { agent: info }));

  const adminJobRunner = new AdminJobRunner({ agents, log, broadcast });
  const updateManager = new UpdateManager({
    repoRoot: REPO_ROOT,
    currentVersion: VERSION,
    packaged: PACKAGED,
    dataDir: config.dataDir,
    // A wildcard bind is reachable on loopback; a specific address only on itself.
    localUrl: `http://${config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host}:${config.port}`,
    log,
    broadcast,
  });
  const tunnelManager = new TunnelManager({
    tunnel: config.tunnel,
    dataDir: config.dataDir,
    logger: log,
    // Read at call time: `broadcast` is bound to the socket.io instance below.
    notify: (level, text) => broadcast('notify', { level, text }),
  });

  const activeAccounts = new ActiveAccounts(config.dataDir, (id) => store.getAccount(id));
  const usage = new UsageCollector({ agents, envFor: (agentId) => activeAccounts.envFor(agentId) });
  const usageWatcher = new UsageWatcher({
    collect: () => usage.collect(),
    record: (usages) => stats.recordPlans(usages),
    // Reading limits spawns the agent CLIs — only worth it while agents are in use.
    active: () => terminals.list().length > 0 || (stats.runs({ limit: 1 }).runs[0]?.endedAt ?? 0) > Date.now() - 3 * 3600_000,
    notify: (alert) => {
      const { title, body } = alertText(alert);
      notifications.notify({ kind: 'usage-limit', state: 'limit', title, body });
    },
    onError: (err) => log.warn({ err }, 'usage watcher reading failed'),
  });
  usageWatcher.start();

  const keepAwake = new KeepAwake({
    dataDir: config.dataDir,
    busy: () => {
      const n = terminals.busyAgents() + manager.activeSessionIds().length;
      return n > 0 ? `${n} ${n === 1 ? 'agent' : 'agents'} working` : null;
    },
    log,
  });
  keepAwake.start();

  // Dev-server previews on the next port (AgentDeck's port 0 = tests: a random one).
  const preview = new PreviewProxy({ secretHex: jwtSecret, host: config.host, port: config.port ? config.port + 1 : 0, log });
  await preview.start();

  const deps: AppDeps = {
    config,
    log,
    store,
    agents,
    manager,
    teams: new TeamOrchestrator(store, manager, log),
    usage,
    usageWatcher,
    worktrees: new WorktreeStore(config.dataDir),
    keepAwake,
    preview,
    activeAccounts,
    stats,
    pairing,
    limiter,
    remoteLimiter: new AttemptLimiter(10),
    pairRequests: new PairRequests(),
    tunnel: tunnelManager,
    adminJobs: adminJobRunner,
    update: updateManager,
    terminals,
    routines,
    notifications,
    voice: new VoiceService({ config, log }),
    hookLimiter: new RateLimiter(30, 60_000),
    jwtSecret,
    bridgeToken,
    bridgeGuard: makeBridgeGuard(bridgeToken),
    broadcast,
    fileWatchers,
    pairingCode,
    ...(webDist ? { webDist } : {}),
  };

  // Restore persistent tmux terminals that survived a server restart
  terminals.restoreAll(terminalBroadcasts(deps));

  // Auth for /api/* (health, pair and the bridge scope are handled separately).
  app.addHook('onRequest', makeDeviceAuthHook(jwtSecret, (deviceId) => store.touchDevice(deviceId)));

  // API answers go out gzipped: a chat history or a diff shrinks to a fraction,
  // which is what a phone on mobile data waits for. Only serialized JSON/text —
  // file streams and downloads pass through untouched.
  app.addHook('onSend', async (req, reply, payload) => {
    if (typeof payload !== 'string' || payload.length < GZIP_MIN_CHARS) return payload;
    if (req.method === 'HEAD' || reply.hasHeader('content-encoding')) return payload;
    if (!/\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''))) return payload;
    if (!/json|^text\//i.test(String(reply.getHeader('content-type') ?? ''))) return payload;
    const zipped = await gzip(payload);
    reply.header('content-encoding', 'gzip');
    reply.header('vary', 'Accept-Encoding');
    reply.removeHeader('content-length');
    return zipped;
  });

  // Error shaping: every error is {"error":{"message","code"}}. Declared
  // BEFORE the routes plugin registers so the /api encapsulation context
  // inherits it (handlers set after register() never reach child plugins).
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const where = first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid request';
      reply.code(400).send({ error: { message: where, code: 'BAD_REQUEST' } });
      return;
    }
    const statusCode = typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    if (statusCode >= 500) {
      req.log.error({ err }, 'request failed');
    }
    const message =
      statusCode >= 500 && (err as { name?: string }).name !== 'HttpError'
        ? 'Internal Server Error'
        : err.message;
    const code = (err as { code?: string }).code ?? (statusCode === 404 ? 'NOT_FOUND' : statusCode >= 500 ? 'INTERNAL' : 'REQUEST_FAILED');
    reply.code(statusCode).send({ error: { message, code } });
  });

  await app.register(registerRoutes, { deps, prefix: '/api' });

  // Watchers must not keep the process alive past app close (tests, shutdown);
  // terminals detach so background tmux sessions stay alive across restarts.
  app.addHook('onClose', async () => {
    routines.stop();
    usageWatcher.stop();
    keepAwake.stop();
    await preview.stop();
    terminals.detachAll();
    adminJobRunner.stop('Server shutting down');
    await adminJobRunner.idle().catch(() => undefined);
    fileWatchers.stopAll();
    stats.close();
  });

  app.setNotFoundHandler((req, reply) => {
    const url = (req.url || '').split('?')[0] ?? '';
    if (url.startsWith('/api/') || url.startsWith('/socket.io')) {
      reply.code(404).send({ error: { message: 'Not found', code: 'NOT_FOUND' } });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      reply.code(404).send({ error: { message: 'Not found', code: 'NOT_FOUND' } });
      return;
    }
    if (webDist) {
      reply.sendFile('index.html');
      return;
    }
    reply.type('text/html').send(FALLBACK_HTML);
  });

  return { app, io, deps, store, agents, manager, tunnel: tunnelManager, adminJobs: adminJobRunner, logger: log };
}

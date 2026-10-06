/**
 * NotificationHub: turns noteworthy server events (run finished, run failed,
 * terminal waiting, team done) into DeckNotifications, broadcasts them over
 * WS for the in-app inbox and delivers them via Web Push to subscribed
 * devices — so the phone buzzes even when the app is closed.
 *
 * VAPID keys and subscriptions live in the data dir (0600).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import webpush from 'web-push';
import type {
  DeckNotification,
  DeckNotificationKind,
  DeckNotificationState,
  PushSubscribeRequest,
  QuietHours,
} from '@agentdeck/shared';
import type { Logger } from '../logging.js';
import { newId } from '../util/ids.js';
import { FcmClient } from './fcm.js';

interface StoredSubscription {
  deviceId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  kinds?: DeckNotificationKind[];
  quiet?: QuietHours;
  createdAt: number;
}

interface StoredFcmToken {
  deviceId: string;
  token: string;
  kinds?: DeckNotificationKind[];
  quiet?: QuietHours;
  createdAt: number;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface NotificationHubOptions {
  dataDir: string;
  log: Logger;
  broadcast: (notification: DeckNotification) => void;
  /** mailto:/https: contact sent to push services. */
  subject?: string;
}

const HISTORY_LIMIT = 100;

/** True while the device's local clock is inside its quiet window (may wrap midnight). */
export function inQuietHours(q: QuietHours | undefined, now = Date.now()): boolean {
  if (!q || q.from === q.to) return false;
  const local = new Date(now + q.tzOffset * 60_000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return q.from < q.to ? minute >= q.from && minute < q.to : minute >= q.from || minute < q.to;
}

export class NotificationHub {
  private vapid: VapidKeys | undefined;
  private subs: StoredSubscription[] = [];
  private readonly history: DeckNotification[] = [];
  private fcm: FcmClient | undefined;
  private fcmTokens: StoredFcmToken[] = [];
  private readonly subsFile: string;
  private readonly vapidFile: string;
  private readonly fcmTokensFile: string;

  constructor(private readonly opts: NotificationHubOptions) {
    this.subsFile = path.join(opts.dataDir, 'push-subscriptions.json');
    this.vapidFile = path.join(opts.dataDir, 'vapid.json');
    this.fcmTokensFile = path.join(opts.dataDir, 'fcm-tokens.json');
  }

  async init(): Promise<void> {
    await fsp.mkdir(this.opts.dataDir, { recursive: true });
    try {
      this.vapid = JSON.parse(await fsp.readFile(this.vapidFile, 'utf8')) as VapidKeys;
    } catch {
      this.vapid = webpush.generateVAPIDKeys();
      await fsp.writeFile(this.vapidFile, JSON.stringify(this.vapid), { mode: 0o600 });
    }
    webpush.setVapidDetails(this.opts.subject ?? 'mailto:agentdeck@localhost', this.vapid.publicKey, this.vapid.privateKey);
    try {
      this.subs = JSON.parse(await fsp.readFile(this.subsFile, 'utf8')) as StoredSubscription[];
    } catch {
      this.subs = [];
    }
    this.fcm = await FcmClient.load(path.join(this.opts.dataDir, 'fcm-service-account.json'));
    try {
      this.fcmTokens = JSON.parse(await fsp.readFile(this.fcmTokensFile, 'utf8')) as StoredFcmToken[];
    } catch {
      this.fcmTokens = [];
    }
  }

  /** Server can send FCM (service-account key present). */
  get fcmEnabled(): boolean {
    return this.fcm !== undefined;
  }

  async registerFcm(deviceId: string, token: string, kinds?: DeckNotificationKind[], quiet?: QuietHours): Promise<void> {
    this.fcmTokens = this.fcmTokens.filter((t) => t.token !== token);
    this.fcmTokens.push({ deviceId, token, ...(kinds ? { kinds } : {}), ...(quiet ? { quiet } : {}), createdAt: Date.now() });
    await this.persistFcm();
  }

  async unregisterFcm(deviceId: string, token?: string): Promise<void> {
    this.fcmTokens = this.fcmTokens.filter((t) => !(t.deviceId === deviceId && (!token || t.token === token)));
    await this.persistFcm();
  }

  fcmCount(deviceId: string): number {
    return this.fcmTokens.filter((t) => t.deviceId === deviceId).length;
  }

  get publicKey(): string | undefined {
    return this.vapid?.publicKey;
  }

  subscriptionCount(deviceId: string): number {
    return this.subs.filter((s) => s.deviceId === deviceId).length;
  }

  recent(): DeckNotification[] {
    return [...this.history];
  }

  async subscribe(deviceId: string, req: PushSubscribeRequest): Promise<void> {
    this.subs = this.subs.filter((s) => s.endpoint !== req.endpoint);
    this.subs.push({
      deviceId,
      endpoint: req.endpoint,
      keys: req.keys,
      ...(req.kinds ? { kinds: req.kinds } : {}),
      ...(req.quiet ? { quiet: req.quiet } : {}),
      createdAt: Date.now(),
    });
    await this.persist();
  }

  async unsubscribe(deviceId: string, endpoint?: string): Promise<void> {
    this.subs = this.subs.filter((s) => !(s.deviceId === deviceId && (!endpoint || s.endpoint === endpoint)));
    await this.persist();
  }

  /** Drop every subscription of a revoked device. */
  async forgetDevice(deviceId: string): Promise<void> {
    await this.unsubscribe(deviceId);
    await this.unregisterFcm(deviceId);
  }

  /**
   * Build + broadcast + push. Returns the notification. `urgent` reaches every
   * device regardless of its kind filter and quiet hours.
   */
  notify(input: Omit<DeckNotification, 'id' | 'ts'>, opts: { urgent?: boolean } = {}): DeckNotification {
    const notification: DeckNotification = { ...input, id: newId('n'), ts: Date.now() };
    this.history.push(notification);
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    this.opts.broadcast(notification);
    void this.push(notification, opts.urgent ? () => true : undefined);
    void this.pushFcm(notification, opts.urgent ? () => true : undefined);
    return notification;
  }

  /** Test push to one device's subscriptions. */
  async test(deviceId: string): Promise<number> {
    const n: DeckNotification = {
      id: newId('n'),
      kind: 'info',
      title: 'AgentDeck',
      body: 'Push notifications work 🎉',
      ts: Date.now(),
    };
    // An explicit test ignores the per-kind filter — it checks delivery.
    const web = await this.push(n, (s) => s.deviceId === deviceId);
    return web + (await this.pushFcm(n, (t) => t.deviceId === deviceId));
  }

  private async push(n: DeckNotification, only?: (s: StoredSubscription) => boolean): Promise<number> {
    if (!this.vapid) return 0;
    const targets = this.subs.filter((s) =>
      only ? only(s) : (!s.kinds || s.kinds.includes(n.kind)) && !inQuietHours(s.quiet),
    );
    if (targets.length === 0) return 0;
    const payload = JSON.stringify(n);
    const dead: string[] = [];
    let delivered = 0;
    await Promise.all(
      targets.map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, {
            TTL: 60 * 60,
            urgency:
              n.kind === 'session-error' || n.kind === 'terminal-attention' || n.state === 'waiting' || n.state === 'limit'
                ? 'high'
                : 'normal',
            topic: n.terminalId ?? n.sessionId ?? n.runId,
          } as webpush.RequestOptions);
          delivered++;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) dead.push(s.endpoint);
          else this.opts.log.warn({ status, err: (err as Error).message }, 'web push failed');
        }
      }),
    );
    if (dead.length) {
      this.subs = this.subs.filter((s) => !dead.includes(s.endpoint));
      await this.persist();
    }
    return delivered;
  }

  private async pushFcm(n: DeckNotification, only?: (t: StoredFcmToken) => boolean): Promise<number> {
    const fcm = this.fcm;
    if (!fcm) return 0;
    const targets = this.fcmTokens.filter((t) =>
      only ? only(t) : (!t.kinds || t.kinds.includes(n.kind)) && !inQuietHours(t.quiet),
    );
    if (targets.length === 0) return 0;
    const state = n.state ?? (n.kind === 'terminal-attention' ? 'waiting' : undefined);
    const open = n.terminalId ? `terminal:${n.terminalId}` : n.sessionId ? `session:${n.sessionId}` : n.runId ? `team:${n.runId}` : '';
    const message = {
      title: n.title,
      body: n.body,
      channelId: fcmChannel(n),
      high: n.kind === 'session-error' || n.kind === 'terminal-attention' || state === 'waiting' || state === 'limit',
      data: {
        open,
        notificationId: n.id,
        kind: n.kind,
        ...(n.state ? { state: n.state } : {}),
        ...(n.terminalId && n.prompt ? { terminalId: n.terminalId, prompt: n.prompt } : {}),
        ...(n.sessionId && n.permissionId ? { sessionId: n.sessionId, permissionId: n.permissionId } : {}),
      },
      // Answer buttons need a notification the app draws itself.
      ...((n.terminalId && n.prompt) || (n.sessionId && n.permissionId) ? { dataOnly: true } : {}),
      ...(n.terminalId ?? n.sessionId ?? n.runId ? { tag: (n.terminalId ?? n.sessionId ?? n.runId) as string } : {}),
    };
    const dead: string[] = [];
    let delivered = 0;
    await Promise.all(
      targets.map(async (t) => {
        const res = await fcm.send(t.token, message);
        if (res === 'ok') delivered++;
        else if (res === 'dead') dead.push(t.token);
        else this.opts.log.warn('fcm push failed');
      }),
    );
    if (dead.length) {
      this.fcmTokens = this.fcmTokens.filter((t) => !dead.includes(t.token));
      await this.persistFcm();
    }
    return delivered;
  }

  private async persistFcm(): Promise<void> {
    const tmp = `${this.fcmTokensFile}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this.fcmTokens, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, this.fcmTokensFile);
  }

  private async persist(): Promise<void> {
    const tmp = `${this.subsFile}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this.subs, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, this.subsFile);
  }
}

/** Android channel (created by the app) per state — mirrors web/src/util/notify.ts. */
function fcmChannel(n: Pick<DeckNotification, 'kind' | 'state'>): string {
  const state = n.state ?? (n.kind === 'terminal-attention' ? 'waiting' : undefined);
  if (state === 'done') return 'agentdeck-done';
  if (state === 'waiting') return 'agentdeck-waiting';
  if (state === 'limit') return 'agentdeck-limit';
  return 'agentdeck-alerts';
}

/** Leads every title, so the state is readable on a lock screen at a glance. */
const STATE_MARK: Record<DeckNotificationState, string> = {
  done: '✅',
  waiting: '✋',
  limit: '⛔',
  error: '⚠️',
};

const STATE_PHRASE: Record<DeckNotificationState, string> = {
  done: 'is done',
  waiting: 'needs your input',
  limit: 'hit its usage limit',
  error: 'failed',
};

/** "✋ Claude Code needs your input · winterlicht" */
export function stateTitle(state: DeckNotificationState, who: string, where: string): string {
  return `${STATE_MARK[state]} ${who} ${STATE_PHRASE[state]} · ${where}`;
}

/** Collapses an assistant reply into a notification body. */
export function summarize(text: string | undefined, max = 140): string {
  if (!text) return '';
  const flat = text
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/[#*_`>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}


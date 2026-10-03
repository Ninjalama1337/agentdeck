/**
 * System notifications on every platform AgentDeck runs on:
 *
 * - APK (Capacitor): LocalNotifications plugin while the app process lives
 * - PWA / browser:   Web Push via the service worker (works with the app
 *                    closed — needs HTTPS, e.g. the Cloudflare tunnel) and a
 *                    ServiceWorkerRegistration.showNotification fallback
 *                    while the tab is merely in the background
 *
 * Deep links use `/?open=<target>` so a tap lands on the right screen.
 */
import type { DeckNotification, DeckNotificationKind, DeckNotificationState, QuietHours } from '@agentdeck/shared';
import { api } from '../api/client';
import { usePrefs } from '../store/prefs';
import { isNativePlatform } from './platform';

export type Permission = 'granted' | 'denied' | 'default' | 'unsupported';

function localPlugin() {
  return window.Capacitor?.Plugins?.LocalNotifications;
}

/** `/?open=…` target for a notification. */
export function openTargetOf(n: Pick<DeckNotification, 'sessionId' | 'terminalId' | 'runId'>): string | undefined {
  if (n.terminalId) return `terminal:${n.terminalId}`;
  if (n.sessionId) return `session:${n.sessionId}`;
  if (n.runId) return `team:${n.runId}`;
  return undefined;
}

/** State of a notification; servers that predate the field only say it via the kind. */
export function stateOf(n: Pick<DeckNotification, 'kind' | 'state'>): DeckNotificationState | undefined {
  if (n.state) return n.state;
  if (n.kind === 'session-done' || n.kind === 'team-done') return 'done';
  if (n.kind === 'session-error' || n.kind === 'team-error') return 'error';
  if (n.kind === 'terminal-attention') return 'waiting';
  return undefined;
}

export async function permissionState(): Promise<Permission> {
  const plugin = localPlugin();
  if (isNativePlatform()) {
    if (!plugin?.checkPermissions) return 'unsupported';
    try {
      const res = (await plugin.checkPermissions()) as { display?: string };
      return res.display === 'granted' ? 'granted' : res.display === 'denied' ? 'denied' : 'default';
    } catch {
      return 'unsupported';
    }
  }
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission as Permission;
}

export async function requestPermission(): Promise<Permission> {
  const plugin = localPlugin();
  if (isNativePlatform()) {
    if (!plugin?.requestPermissions) return 'unsupported';
    try {
      const res = (await plugin.requestPermissions()) as { display?: string };
      return res.display === 'granted' ? 'granted' : 'denied';
    } catch {
      return 'unsupported';
    }
  }
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    return (await Notification.requestPermission()) as Permission;
  } catch {
    return 'denied';
  }
}

/** Android channel for agent alerts: high importance so they pop up and buzz. */
const NATIVE_CHANNEL = 'agentdeck-alerts';
/**
 * One more channel per state, so Android's notification settings can give
 * "done", "needs input" and "usage limit" their own sound and vibration.
 */
const STATE_CHANNELS: Partial<Record<DeckNotificationState, { id: string; name: string; description: string }>> = {
  done: { id: 'agentdeck-done', name: 'Agent finished', description: 'An agent or team run is done' },
  waiting: { id: 'agentdeck-waiting', name: 'Agent needs input', description: 'An agent stopped to ask you something' },
  limit: { id: 'agentdeck-limit', name: 'Usage limit reached', description: 'An agent ran out of usage or quota' },
};
let nativeChannelReady = false;

/**
 * APK only: create the alert channel and, while the "Notify me" pref is on,
 * ask for the notification permission once (Android 13+ grants nothing by
 * default, so alerts would silently never show).
 */
export async function prepareNativeNotifications(): Promise<void> {
  const plugin = localPlugin();
  if (!isNativePlatform() || !plugin) return;
  try {
    await plugin.createChannel?.({
      id: NATIVE_CHANNEL,
      name: 'Agent alerts',
      description: 'Finished runs, failures and terminals waiting for you',
      importance: 4,
      visibility: 1,
      vibration: true,
    });
    for (const channel of Object.values(STATE_CHANNELS)) {
      await plugin.createChannel?.({ ...channel, importance: 4, visibility: 1, vibration: true });
    }
    nativeChannelReady = plugin.createChannel !== undefined;
  } catch {
    nativeChannelReady = false;
  }
  if (!usePrefs.getState().notifications) return;
  try {
    const res = (await plugin.checkPermissions?.()) as { display?: string } | undefined;
    if (res?.display?.startsWith('prompt')) await plugin.requestPermissions?.();
  } catch {
    /* plugin missing in this build */
  }
}

/** Felt in the pocket: one tap = done, two = needs input, a long buzz = limit or failure. */
export function vibrationOf(state: DeckNotificationState | undefined): number[] {
  if (state === 'waiting') return [120, 90, 120];
  if (state === 'limit' || state === 'error') return [450];
  return [120];
}

let nativeSeq = 1;

/** Shows one notification through whatever the platform offers. */
export async function showSystemNotification(n: DeckNotification): Promise<boolean> {
  const open = openTargetOf(n);
  const state = stateOf(n);
  const plugin = localPlugin();
  if (isNativePlatform() && plugin?.schedule) {
    try {
      await plugin.schedule({
        notifications: [
          {
            id: (nativeSeq = (nativeSeq % 100_000) + 1),
            title: n.title,
            body: n.body,
            ...(nativeChannelReady ? { channelId: STATE_CHANNELS[state ?? 'error']?.id ?? NATIVE_CHANNEL } : {}),
            extra: { open },
          },
        ],
      });
      return true;
    } catch {
      return false;
    }
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const options: NotificationOptions & { renotify?: boolean; vibrate?: number[] } = {
      body: n.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: n.terminalId ?? n.sessionId ?? n.runId ?? n.id,
      renotify: true,
      vibrate: vibrationOf(state),
      requireInteraction: state === 'waiting' || state === 'limit',
      data: { open },
    };
    if (reg) {
      await reg.showNotification(n.title, options);
    } else {
      const notif = new Notification(n.title, options);
      notif.onclick = () => {
        window.focus();
        if (open) window.dispatchEvent(new CustomEvent('agentdeck:open', { detail: open }));
      };
    }
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------- FCM (APK, survives Doze) */

function fcmPlugin() {
  return window.Capacitor?.Plugins?.PushNotifications as unknown as
    | {
        checkPermissions?: () => Promise<{ receive?: string }>;
        requestPermissions?: () => Promise<{ receive?: string }>;
        register?: () => Promise<void>;
        unregister?: () => Promise<void>;
        addListener?: (ev: string, cb: (e: never) => void) => unknown;
      }
    | undefined;
}

let fcmToken: string | null = null;
let fcmListening = false;

/** This APK holds an FCM token the server knows (system pushes wake the app). */
export function fcmRegistered(): boolean {
  return fcmToken !== null;
}

/**
 * APK only: gets the device's FCM token and registers it on the server, so
 * notifications arrive through Google's push channel even when Android froze
 * the app. Resolves false when unavailable (old APK, server without FCM key,
 * permission denied) — the WebSocket path still works then.
 */
export async function enableFcm(): Promise<boolean> {
  const plugin = fcmPlugin();
  if (!isNativePlatform() || !plugin?.register) return false;
  try {
    const status = await api.pushStatus();
    if (!status.fcm) return false;
    let perm = (await plugin.checkPermissions?.())?.receive;
    if (perm?.startsWith('prompt')) perm = (await plugin.requestPermissions?.())?.receive;
    if (perm !== 'granted') return false;
    if (!fcmListening) {
      fcmListening = true;
      plugin.addListener?.('registration', ((e: { value: string }) => {
        fcmToken = e.value;
        void api.fcmRegister({ token: e.value, kinds: enabledKinds(), quiet: quietHours() }).catch(() => undefined);
      }) as never);
    }
    await plugin.register();
    // The 'registration' event is async; wait briefly for the token.
    for (let i = 0; i < 20 && fcmToken === null; i++) await new Promise((r) => setTimeout(r, 250));
    return fcmToken !== null;
  } catch {
    return false;
  }
}

export async function disableFcm(): Promise<void> {
  const token = fcmToken;
  fcmToken = null;
  await api.fcmUnregister(token ?? undefined).catch(() => undefined);
}

/** Native taps → the same `agentdeck:open` event the service worker uses. */
export function listenForNativeTaps(): void {
  const plugin = localPlugin() as unknown as
    | { addListener?: (ev: string, cb: (e: { notification?: { extra?: { open?: string } } }) => void) => void }
    | undefined;
  plugin?.addListener?.('localNotificationActionPerformed', (e) => {
    const open = e.notification?.extra?.open;
    if (open) window.dispatchEvent(new CustomEvent('agentdeck:open', { detail: open }));
  });
  // Tap on a notification the system showed for an FCM message.
  fcmPlugin()?.addListener?.('pushNotificationActionPerformed', ((e: { notification?: { data?: { open?: string } } }) => {
    const open = e.notification?.data?.open;
    if (open) window.dispatchEvent(new CustomEvent('agentdeck:open', { detail: open }));
  }) as never);
}

/* ---------------------------------------------------------------- Web Push */

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported(): boolean {
  return (
    !isNativePlatform() &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof Notification !== 'undefined'
  );
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/** Notification kinds this device wants (the per-kind toggles in Settings). */
function enabledKinds(): DeckNotificationKind[] {
  const kinds = usePrefs.getState().notifyKinds;
  return (Object.keys(kinds) as DeckNotificationKind[]).filter((k) => kinds[k]);
}

/** Quiet window for the server to honour, or undefined when switched off. */
function quietHours(): QuietHours | undefined {
  const q = usePrefs.getState().quietHours;
  if (!q.enabled) return undefined;
  const minutes = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  return { from: minutes(q.from), to: minutes(q.to), tzOffset: -new Date().getTimezoneOffset() };
}

function subscribeRequest(sub: PushSubscription) {
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return null;
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, kinds: enabledKinds(), quiet: quietHours() };
}

/** Re-registers the existing subscription so the server honours changed kind toggles. */
export async function syncPushKinds(): Promise<void> {
  if (fcmToken) await api.fcmRegister({ token: fcmToken, kinds: enabledKinds(), quiet: quietHours() }).catch(() => undefined);
  const sub = await currentPushSubscription();
  const req = sub && subscribeRequest(sub);
  if (req) await api.pushSubscribe(req).catch(() => undefined);
}

export type PushResult = 'subscribed' | 'unsupported' | 'denied' | 'server-disabled' | 'error';

/** Subscribes this browser to Web Push and registers it on the server. */
export async function enablePush(): Promise<PushResult> {
  if (!pushSupported()) return 'unsupported';
  const perm = await requestPermission();
  if (perm !== 'granted') return 'denied';
  try {
    const status = await api.pushStatus();
    if (!status.enabled || !status.publicKey) return 'server-disabled';
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const key = urlBase64ToUint8Array(status.publicKey);
    if (sub) {
      // Server keys rotated (new data dir) → resubscribe.
      const existing = sub.options.applicationServerKey;
      if (existing && new Uint8Array(existing).toString() !== key.toString()) {
        await sub.unsubscribe();
        sub = null;
      }
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const req = subscribeRequest(sub);
    if (!req) return 'error';
    await api.pushSubscribe(req);
    return 'subscribed';
  } catch {
    return 'error';
  }
}

export async function disablePush(): Promise<void> {
  const sub = await currentPushSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => undefined);
  await api.pushUnsubscribe(endpoint).catch(() => undefined);
}

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
import type { DeckNotification } from '@agentdeck/shared';
import { api } from '../api/client';
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

let nativeSeq = 1;

/** Shows one notification through whatever the platform offers. */
export async function showSystemNotification(n: DeckNotification): Promise<boolean> {
  const open = openTargetOf(n);
  const plugin = localPlugin();
  if (isNativePlatform() && plugin?.schedule) {
    try {
      await plugin.schedule({
        notifications: [
          {
            id: (nativeSeq = (nativeSeq % 100_000) + 1),
            title: n.title,
            body: n.body,
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
    const options: NotificationOptions & { renotify?: boolean } = {
      body: n.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: n.terminalId ?? n.sessionId ?? n.runId ?? n.id,
      renotify: true,
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

/** Native taps → the same `agentdeck:open` event the service worker uses. */
export function listenForNativeTaps(): void {
  const plugin = localPlugin() as unknown as
    | { addListener?: (ev: string, cb: (e: { notification?: { extra?: { open?: string } } }) => void) => void }
    | undefined;
  plugin?.addListener?.('localNotificationActionPerformed', (e) => {
    const open = e.notification?.extra?.open;
    if (open) window.dispatchEvent(new CustomEvent('agentdeck:open', { detail: open }));
  });
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
    const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return 'error';
    await api.pushSubscribe({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
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

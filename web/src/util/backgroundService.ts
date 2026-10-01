/**
 * APK only: an Android foreground service that keeps the app process — and
 * with it the WebView's socket — alive while the app is in the background.
 * Without it Android freezes the process after a short while and "agent
 * finished / waiting" alerts never arrive (the WebView has no Web Push).
 *
 * The service holds a wake lock and shows a permanent notification, so it
 * only runs while there is something to wait for (see App.tsx).
 */
import { isNativePlatform } from './platform';

const CHANNEL = 'agentdeck-background';
const NOTIFICATION_ID = 4711;
/** Drawable written by mobile/scripts/patch-android.mjs. */
const SMALL_ICON = 'ic_stat_agentdeck';

function plugin() {
  return window.Capacitor?.Plugins?.ForegroundService;
}

/** False in the browser/PWA and in APK builds that predate the plugin. */
export function backgroundServiceSupported(): boolean {
  return isNativePlatform() && plugin()?.startForegroundService !== undefined;
}

/** null = unknown (fresh start: a service from a previous run may still be up). */
let running: boolean | null = null;
let channelReady = false;
let queue: Promise<void> = Promise.resolve();

async function apply(wanted: boolean): Promise<void> {
  const p = plugin();
  if (!p?.startForegroundService || wanted === running) return;
  if (!wanted) {
    await p.stopForegroundService?.();
    running = false;
    return;
  }
  // Android refuses to start a foreground service from the background.
  if (document.visibilityState !== 'visible') return;
  if (!channelReady) {
    // Low importance: no sound, no pop-up. A missing channel would make the
    // service's notification invalid, so never start without it.
    await p.createNotificationChannel?.({
      id: CHANNEL,
      name: 'Background connection',
      description: 'Shown while AgentDeck stays connected in the background',
      importance: 2,
    });
    channelReady = true;
  }
  await p.startForegroundService({
    id: NOTIFICATION_ID,
    title: 'AgentDeck',
    body: 'Connected — you get notified when an agent needs you',
    smallIcon: SMALL_ICON,
    silent: true,
    notificationChannelId: CHANNEL,
  });
  running = true;
}

/** Starts or stops the service; calls are serialized, failures retried on the next call. */
export function syncBackgroundService(wanted: boolean): void {
  if (!backgroundServiceSupported()) return;
  queue = queue.then(() => apply(wanted)).catch(() => undefined);
}

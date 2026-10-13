import { lazy, Suspense, useCallback, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useAppStore } from './store/appStore';
import type { Route } from './store/appStore';
import { usePrefs } from './store/prefs';
import { Aurora } from './components/Aurora';
import { TabBar } from './components/TabBar';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { ToastStack } from './components/ui/Toast';
import { Lightbox } from './components/Lightbox';
import { UpdateBanner } from './components/UpdateBanner';
import { OtherServers } from './components/SavedServers';
import { PairScreen } from './features/pairing/PairScreen';
import { PairApproval } from './features/pairing/PairApproval';
import { HomeScreen } from './features/home/HomeScreen';
import { ChatScreen } from './features/chat/ChatScreen';
import { TeamScreen } from './features/chat/TeamScreen';
import { getApiBase } from './api/client';
import { installExternalLinkHandler } from './util/openExternal';
import { disableFcm, enableFcm, listenForNativeTaps, prepareNativeNotifications, syncActionCredentials } from './util/notify';
import { backgroundServiceSupported, syncBackgroundService } from './util/backgroundService';
import { UsageSheet } from './features/settings/UsageSheet';
import { ActivitySheet } from './features/activity/ActivitySheet';
import { ShareSheet } from './features/share/ShareSheet';
import { listenForNativeShares, takeStashedShare } from './util/shareTarget';
import { listenForKeyboardMedia } from './util/incomingFiles';
import { useUsageTracking } from './hooks/useUsageTracking';
import { Spinner } from './components/ui/Spinner';
import { desktopFrame, useDesktopLayout } from './hooks/useDesktopLayout';
import { matchShortcut, OPEN_PROJECT_SWITCHER } from './util/shortcuts';
import { attachPaneSync } from './features/code/paneSync';
import { usePanes } from './features/code/paneStore';

// Home and chat are in the first download; the heavier tabs (terminal
// emulator, git, files, settings) come as their own chunks, so the app is on
// screen sooner. They are fetched right after start, before anyone taps them.
const screenChunks = {
  code: () => import('./features/code/CodeScreen'),
  files: () => import('./features/files/FilesScreen'),
  git: () => import('./features/git/GitScreen'),
  settings: () => import('./features/settings/SettingsScreen'),
};

/** A chunk can only be missing when the server was updated under an open tab: load the current build once. */
function loadScreen<T>(load: () => Promise<T>): Promise<T> {
  return load().catch((err: unknown) => {
    const KEY = 'agentdeck:chunk-reload';
    try {
      if (Date.now() - Number(sessionStorage.getItem(KEY) ?? 0) > 60_000) {
        sessionStorage.setItem(KEY, String(Date.now()));
        window.location.reload();
      }
    } catch {
      /* no session storage — fall through to the error */
    }
    throw err;
  });
}

const CodeScreen = lazy(() => loadScreen(screenChunks.code).then((m) => ({ default: m.CodeScreen })));
const FilesScreen = lazy(() => loadScreen(screenChunks.files).then((m) => ({ default: m.FilesScreen })));
const GitScreen = lazy(() => loadScreen(screenChunks.git).then((m) => ({ default: m.GitScreen })));
const SettingsScreen = lazy(() => loadScreen(screenChunks.settings).then((m) => ({ default: m.SettingsScreen })));

export default function App() {
  const token = useAppStore((s) => s.token);

  // ?server=<url> deep link (QR in the server console / shared link):
  // re-point this device to a (new) server address before anything boots.
  // Must run before the init effect below — effects execute in order.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const server = params.get('server');
    if (!server) return;
    const clean = server.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(clean)) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    const store = useAppStore.getState();
    if (store.serverBase !== clean) {
      // A server saved under this address: switch to it, keeping the current one.
      const saved = store.servers.find((sv) => sv.base === clean && sv.id !== store.activeServerId);
      if (saved) {
        store.switchServer(saved.id);
        return;
      }
      store.setServerBase(clean);
      store.toast('info', `Server address updated: ${clean}`);
    }
  }, []);
  const booted = useAppStore((s) => s.booted);
  const route = useAppStore((s) => s.route);
  const apkRelease = useAppStore((s) => s.apkRelease);
  const desktop = useDesktopLayout();
  // The soft keyboard only exists on the phone layout (pinch-zoom on a desktop must not hide anything).
  const keyboardOpen = useAppStore((s) => s.keyboardOpen) && !desktop;

  useEffect(() => {
    useAppStore.getState().init();
    listenForNativeTaps();
    const stopPaneSync = attachPaneSync(useAppStore, usePanes);
    const stopLinks = installExternalLinkHandler();
    return () => {
      stopPaneSync();
      stopLinks();
    };
  }, []);

  // CSS hook for the few desktop-only rules in global.css.
  useEffect(() => {
    document.documentElement.dataset.layout = desktop ? 'desktop' : 'mobile';
    return () => {
      delete document.documentElement.dataset.layout;
    };
  }, [desktop]);

  // Desktop shortcuts: Ctrl/Cmd+1…5 tabs, Ctrl/Cmd+, settings, Ctrl/Cmd+K project switcher.
  // Capture phase, so they win over the terminal while it has focus.
  useEffect(() => {
    if (!desktop || !booted) return;
    const onKey = (e: KeyboardEvent) => {
      const inTerminal = e.target instanceof Element && e.target.closest('.xterm') !== null;
      const action = matchShortcut(e, { inTerminal });
      if (!action) return;
      const store = useAppStore.getState();
      // A sheet is open: the shortcuts wait until it is closed.
      if (store.overlayDepth > 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (action.type === 'route') store.navigate(action.route);
      else window.dispatchEvent(new Event(OPEN_PROJECT_SWITCHER));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [desktop, booted]);

  // Usage button: follow the agent in use, refresh every minute.
  useUsageTracking();

  // Warm the other tabs once the first screen is up.
  useEffect(() => {
    if (!booted) return;
    const timer = window.setTimeout(() => {
      for (const load of Object.values(screenChunks)) void load().catch(() => undefined);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [booted]);

  // APK: alert channel + permission prompt, once this device is paired.
  useEffect(() => {
    if (token) void prepareNativeNotifications();
  }, [token]);

  // APK: the notification buttons call the server on their own — hand them its
  // address and this device's login (cleared on sign-out).
  const servers = useAppStore((s) => s.servers);
  const activeServerId = useAppStore((s) => s.activeServerId);
  useEffect(() => {
    syncActionCredentials(getApiBase(), token ?? null);
  }, [servers, activeServerId, token]);

  // APK: FCM token while "Notify me" is on — Google's push channel reaches
  // the app even when Android froze it. Removed again when switched off.
  const notificationsOn = usePrefs((p) => p.notifications);
  useEffect(() => {
    if (!token) return;
    void (async () => {
      if (notificationsOn) await enableFcm();
      else await disableFcm();
      await useAppStore.getState().refreshPushActive();
    })();
  }, [token, notificationsOn]);

  // APK: stay connected in the background while there is something to wait
  // for — a live terminal or a running session. Re-checked when the app
  // comes back to the front, the only time Android lets the service start.
  useEffect(() => {
    if (!backgroundServiceSupported()) return;
    const evaluate = () => {
      const st = useAppStore.getState();
      const prefs = usePrefs.getState();
      const busy =
        st.terminals.length > 0 ||
        Object.values(st.sessionsByProject).some((list) => list.some((s) => s.status === 'running' || s.status === 'queued'));
      // With an FCM token Google's push channel delivers; the service (and its
      // permanent notification) is only the fallback.
      syncBackgroundService(Boolean(st.token) && prefs.notifications && prefs.backgroundService && busy && !st.pushActive);
    };
    evaluate();
    const unsubStore = useAppStore.subscribe(evaluate);
    const unsubPrefs = usePrefs.subscribe(evaluate);
    document.addEventListener('visibilitychange', evaluate);
    return () => {
      unsubStore();
      unsubPrefs();
      document.removeEventListener('visibilitychange', evaluate);
    };
  }, []);

  // Deep links: ?open=session:<id> (notification tap) · ?launch=claude (app shortcut).
  useEffect(() => {
    if (!token) return;
    const params = new URLSearchParams(window.location.search);
    const open = params.get('open');
    const launch = params.get('launch');
    if (!open && !launch) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    const store = useAppStore.getState();
    if (launch) {
      store.setPendingLaunch(launch);
      store.navigate({ name: 'code' });
    }
    if (open) {
      // Wait for bootstrap so sessions/terminals are known.
      const go = () => useAppStore.getState().openTarget(open);
      if (store.booted) go();
      else {
        const unsub = useAppStore.subscribe((st) => {
          if (st.booted) {
            unsub();
            go();
          }
        });
      }
    }
  }, [token]);

  // Soft keyboard tracking via visualViewport: when the visible viewport
  // shrinks well below the layout viewport, a keyboard is open → hide the
  // tab bar so the composer keeps room (chat screens especially), and pin
  // the app shell to the visible area so the top bar never scrolls away.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const rootStyle = document.documentElement.style;
    const evaluate = () => {
      const open = window.innerHeight - vv.height > 120;
      useAppStore.getState().setKeyboardOpen(open);
      if (open) {
        rootStyle.setProperty('--ad-vvh', `${vv.height}px`);
        rootStyle.setProperty('--ad-vv-top', `${vv.offsetTop}px`);
      } else {
        rootStyle.removeProperty('--ad-vvh');
        rootStyle.removeProperty('--ad-vv-top');
      }
    };
    evaluate();
    vv.addEventListener('resize', evaluate);
    vv.addEventListener('scroll', evaluate);
    return () => {
      vv.removeEventListener('resize', evaluate);
      vv.removeEventListener('scroll', evaluate);
      useAppStore.getState().setKeyboardOpen(false);
      rootStyle.removeProperty('--ad-vvh');
      rootStyle.removeProperty('--ad-vv-top');
    };
  }, []);

  // PWA share_target handover: ?shared=1 → what the service worker stashed.
  useEffect(() => {
    if (!token) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has('shared')) return;
    window.history.replaceState(null, '', window.location.pathname);
    void takeStashedShare().then((share) => {
      if (share) useAppStore.getState().offerShare(share);
    });
  }, [token]);

  // APK share target: whatever another app shares is offered to a chat.
  useEffect(() => {
    listenForNativeShares(
      (share) => useAppStore.getState().offerShare(share),
      (message) => useAppStore.getState().toast('warn', message),
    );
    // APK: an image inserted by the keyboard goes to the focused input — with
    // none in focus the user picks the chat, as for a share.
    listenForKeyboardMedia(
      (files) => useAppStore.getState().offerShare({ text: '', files }),
      (message) => useAppStore.getState().toast('warn', message),
    );
  }, []);

  if (!token) {
    return (
      <>
        <Aurora />
        <main className="relative z-10">
          <PairScreen />
        </main>
        <ToastStack />
      </>
    );
  }

  if (!booted) {
    return (
      <>
        <Aurora />
        <main className="relative z-10 flex h-dvh flex-col items-center justify-center gap-4 text-dim">
          <div
            className="flex h-14 w-14 items-center justify-center rounded-2xl text-2xl font-bold text-white"
            style={{ background: 'linear-gradient(135deg,#7C5CFF,#4E8CFF)', boxShadow: '0 8px 32px rgba(124,92,255,0.4)' }}
          >
            A
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Loader2 size={15} className="animate-spin" />
            Connecting to AgentDeck…
          </div>
          {/* This server may be out of reach right now — another saved one may not be. */}
          <OtherServers className="mt-4 w-full max-w-xs" />
        </main>
        <ToastStack />
      </>
    );
  }

  const frame = desktopFrame(route.name);

  return (
    <>
      <Aurora />
      {/* APK self-update: only inside the native shell, when GitHub has a newer
          build than the one bundled into this WebView (see UpdateBanner). */}
      <UpdateBanner apk={apkRelease} />
      {desktop ? (
        // Desktop: sidebar + a wide content area (no top/tab bar).
        <div className="app-shell app-shell-desktop">
          <Sidebar />
          <main className={clsx('relative z-10 h-full min-w-0 flex-1', frame.scroll && 'overflow-y-auto overscroll-contain')}>
            <div className={clsx('mx-auto w-full', frame.scroll ? 'min-h-full' : 'h-full', frame.width)}>
              <Suspense
                fallback={
                  <div className="flex h-full min-h-[40vh] items-center justify-center text-dim">
                    <Spinner />
                  </div>
                }
              >
                <Screen route={route} />
              </Suspense>
            </div>
          </main>
        </div>
      ) : (
        <>
          <div className="app-shell">
            <TopBar />
            <main
              className={[
                keyboardOpen ? 'screen-h-kb' : 'screen-h',
                'relative z-10 mx-auto w-full max-w-xl',
                route.name === 'chat' || route.name === 'code' ? '' : 'overflow-y-auto overscroll-contain',
              ].join(' ')}
            >
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-dim">
                    <Spinner />
                  </div>
                }
              >
                <Screen route={route} />
              </Suspense>
            </main>
          </div>
          <TabBar />
        </>
      )}
      <UsageSheet />
      <ActivityHost />
      <ShareSheet />
      <Lightbox />
      <PairApproval />
      <ToastStack />
    </>
  );
}

/** The screen of a route. */
function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case 'home':
      return <HomeScreen />;
    case 'chat':
      return <ChatScreen />;
    case 'code':
      return <CodeScreen />;
    case 'files':
      return <FilesScreen />;
    case 'git':
      return <GitScreen />;
    case 'settings':
      return <SettingsScreen />;
    case 'team':
      return <TeamScreen runId={route.runId} />;
  }
}

/** The Activity sheet, opened from Home and from the usage sheet. */
function ActivityHost() {
  const open = useAppStore((s) => s.activitySheetOpen);
  const setOpen = useAppStore((s) => s.setActivitySheetOpen);
  const close = useCallback(() => setOpen(false), [setOpen]);
  return <ActivitySheet open={open} onClose={close} />;
}

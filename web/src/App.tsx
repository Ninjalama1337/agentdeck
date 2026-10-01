import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { useAppStore } from './store/appStore';
import { Aurora } from './components/Aurora';
import { TabBar } from './components/TabBar';
import { TopBar } from './components/TopBar';
import { ToastStack } from './components/ui/Toast';
import { Lightbox } from './components/Lightbox';
import { UpdateBanner } from './components/UpdateBanner';
import { PairScreen } from './features/pairing/PairScreen';
import { HomeScreen } from './features/home/HomeScreen';
import { ChatScreen } from './features/chat/ChatScreen';
import { TeamScreen } from './features/chat/TeamScreen';
import { CodeScreen } from './features/code/CodeScreen';
import { FilesScreen } from './features/files/FilesScreen';
import { GitScreen } from './features/git/GitScreen';
import { listenForNativeTaps, prepareNativeNotifications } from './util/notify';
import { SettingsScreen } from './features/settings/SettingsScreen';
import { UsageSheet } from './features/settings/UsageSheet';

/** Consume an image handed over by the PWA share_target (stashed in Cache API by sw.ts). */
async function consumeSharedImage(): Promise<File | null> {
  try {
    const cache = await caches.open('agentdeck-share');
    const res = await cache.match('/__shared__');
    if (!res) return null;
    await cache.delete('/__shared__');
    const blob = await res.blob();
    return new File([blob], `shared-${Date.now()}.jpg`, { type: blob.type || 'image/jpeg' });
  } catch {
    return null;
  }
}

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
      store.setServerBase(clean);
      store.toast('info', `Server address updated: ${clean}`);
    }
  }, []);
  const booted = useAppStore((s) => s.booted);
  const route = useAppStore((s) => s.route);
  const apkInfo = useAppStore((s) => s.apkInfo);
  const keyboardOpen = useAppStore((s) => s.keyboardOpen);

  useEffect(() => {
    useAppStore.getState().init();
    listenForNativeTaps();
  }, []);

  // APK: alert channel + permission prompt, once this device is paired.
  useEffect(() => {
    if (token) void prepareNativeNotifications();
  }, [token]);

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

  // share_target handover: ?shared=1 → queue the stashed image for the composer.
  useEffect(() => {
    if (!token) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has('shared')) return;
    window.history.replaceState(null, '', window.location.pathname);
    void (async () => {
      const file = await consumeSharedImage();
      if (!file) return;
      const store = useAppStore.getState();
      store.queuePendingFiles([file]);
      store.toast('info', 'Screenshot received — open a session to send it');
      store.navigate({ name: 'chat' });
    })();
  }, [token]);

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
        </main>
        <ToastStack />
      </>
    );
  }

  return (
    <>
      <Aurora />
      {/* APK self-update: only inside the native shell, when the server hosts a
          newer build than the one bundled into this WebView (see UpdateBanner). */}
      <UpdateBanner apk={apkInfo} />
      <div className="app-shell">
        <TopBar />
        <main
          className={[
            keyboardOpen ? 'screen-h-kb' : 'screen-h',
            'relative z-10 mx-auto w-full max-w-xl',
            route.name === 'chat' || route.name === 'code' ? '' : 'overflow-y-auto overscroll-contain',
          ].join(' ')}
        >
          {route.name === 'home' && <HomeScreen />}
          {route.name === 'chat' && <ChatScreen />}
          {route.name === 'code' && <CodeScreen />}
          {route.name === 'files' && <FilesScreen />}
          {route.name === 'git' && <GitScreen />}
          {route.name === 'settings' && <SettingsScreen />}
          {route.name === 'team' && <TeamScreen runId={route.runId} />}
        </main>
      </div>
      <TabBar />
      <UsageSheet />
      <Lightbox />
      <ToastStack />
    </>
  );
}

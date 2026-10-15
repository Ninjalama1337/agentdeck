import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import { ApkDownloadLink } from './ApkDownloadLink';
import { apkUpdateAvailable, runningApkVersion, type ApkRelease } from '../util/apkRelease';
import { installedApkVersion } from '../util/download';
import { isNativePlatform } from '../util/platform';
import { useAppStore } from '../store/appStore';

const DISMISS_KEY = 'agentdeck:apk-update-dismissed';

function readDismissed(): string | null {
  try {
    return sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/**
 * Self-update banner for the native APK: when running inside the Capacitor
 * shell (isNativePlatform) and the GitHub release has a NEWER APK than the
 * build this WebView was bundled with, offer a one-tap download straight from
 * GitHub. Android then prompts to install the downloaded file as an app
 * update. Dismissal lives in sessionStorage and is per release version — a
 * newer release makes the banner reappear. The PWA never sees this banner:
 * its version constant stays '0.0.0-web' and updates go through the service
 * worker. A tap on the background check's notification (UpdateCheckWorker.java)
 * shows the banner even when dismissed and starts the install right away.
 */
export function UpdateBanner({ apk }: { apk: ApkRelease | null }) {
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(readDismissed);
  const installRequest = useAppStore((s) => s.apkInstallRequest);

  const native = isNativePlatform();
  /** undefined = still asking Android; null = unknown (older APK). */
  const [installed, setInstalled] = useState<string | null | undefined>(native ? undefined : null);

  useEffect(() => {
    if (!native) return;
    let live = true;
    void installedApkVersion().then((v) => {
      if (!live) return;
      setInstalled(v);
      // A newer APK than this bundle: the service worker served the old one.
      // Fetch the new worker — it reloads the page once it takes over.
      if (v && runningApkVersion(__APK_VERSION__, v) !== __APK_VERSION__) {
        void navigator.serviceWorker?.getRegistration().then((reg) => reg?.update()).catch(() => undefined);
      }
    });
    return () => {
      live = false;
    };
  }, [native]);

  const version = apk?.version;
  const updateAvailable =
    native && installed !== undefined && apkUpdateAvailable(runningApkVersion(__APK_VERSION__, installed), apk);

  if (!apk || !updateAvailable || !version || (dismissedVersion === version && !installRequest)) return null;

  const dismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, version);
    } catch {
      /* storage unavailable */
    }
    setDismissedVersion(version);
  };

  return (
    <div className="safe-t fixed inset-x-0 top-0 z-[55] px-4">
      <div
        className="msg-in flex items-center gap-2.5 rounded-2xl border border-accent/35 p-3 pr-1.5 shadow-glass"
        style={{ background: 'rgba(18, 22, 32, 0.94)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)' }}
        role="alert"
      >
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl btn-primary"
        >
          <Download size={16} className="text-white" />
        </span>
        <p className="min-w-0 flex-1 text-[13.5px] leading-snug">
          <span className="font-semibold">Update available — v{version}</span>
          <span className="block text-[12px] text-dim">Downloads it from GitHub and opens the installer.</span>
        </p>
        <ApkDownloadLink
          release={apk}
          autoStart={installRequest}
          className="press tap flex h-10 shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-[13px] font-semibold text-white btn-primary"
        >
          <Download size={14} />
          Install
        </ApkDownloadLink>
        <button
          type="button"
          aria-label="Dismiss update banner"
          onClick={dismiss}
          className="tap flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-dim active:text-ink"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

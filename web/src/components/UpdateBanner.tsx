import { useState } from 'react';
import { Download, X } from 'lucide-react';
import type { ApkInfo } from '@agentdeck/shared';
import { api } from '../api/client';
import { compareVersions } from '../util/version';
import { isNativePlatform } from '../util/platform';

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
 * shell (isNativePlatform) and the server hosts a NEWER apk than the build
 * this WebView was bundled with, offer a one-tap download of /api/apk/latest.
 * Android then prompts to install the downloaded file as an app update.
 * Dismissal lives in sessionStorage and is per server version — a newer
 * upload makes the banner reappear. The PWA never sees this banner: its
 * version constant stays '0.0.0-web' and updates go through the service worker.
 */
export function UpdateBanner({ apk }: { apk: ApkInfo | null }) {
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(readDismissed);

  const native = isNativePlatform();
  const version = apk?.available ? apk.version : undefined;
  const updateAvailable = native && !!version && compareVersions(__APK_VERSION__, version) < 0;

  if (!updateAvailable || !version || dismissedVersion === version) return null;

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
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
          style={{ background: 'linear-gradient(135deg,#7C5CFF,#4E8CFF)' }}
        >
          <Download size={16} className="text-white" />
        </span>
        <p className="min-w-0 flex-1 text-[13.5px] leading-snug">
          <span className="font-semibold">Update available — v{version}</span>
          <span className="block text-[12px] text-dim">Download and install to get the latest app.</span>
        </p>
        <a
          href={api.apkLatestUrl()}
          download
          className="press tap flex h-10 shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-[13px] font-semibold text-white"
          style={{ background: 'linear-gradient(135deg,#7C5CFF,#4E8CFF)' }}
        >
          <Download size={14} />
          Download
        </a>
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

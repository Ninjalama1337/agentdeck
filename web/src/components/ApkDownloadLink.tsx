import { useState, type CSSProperties, type ReactNode } from 'react';
import type { ApkInfo } from '@agentdeck/shared';
import { api } from '../api/client';
import { errorMessage, useAppStore } from '../store/appStore';
import { downloadApkNatively, installApkUpdate } from '../util/download';
import { isNativePlatform } from '../util/platform';

interface Props {
  info: ApkInfo;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/**
 * Download link for the server's latest APK. In the browser/PWA it is a plain
 * `<a download>` (no auth header), so the browser's download manager and
 * "open with installer" flow take over. Inside the APK it updates the app in
 * place: download with progress, then Android's installer. APKs that cannot
 * do that yet save the file to Downloads instead — following the link there
 * would open a browser tab that stays behind after every update.
 */
export function ApkDownloadLink({ info, className, style, children }: Props) {
  const toast = useAppStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const href = api.apkLatestUrl();

  const updateInApp = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setProgress(0);
      if (await installApkUpdate(setProgress)) return;
      setProgress(null);
      const fileName = info.fileName ?? `AgentDeck${info.version ? `-${info.version}` : ''}.apk`;
      const saved = await downloadApkNatively(fileName, () => toast('info', 'Downloading the app update…'));
      if (saved) toast('info', 'Saved to Downloads — open it there to install');
      else window.location.href = href;
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setProgress(null);
      setBusy(false);
    }
  };

  return (
    <a
      href={href}
      download
      aria-busy={busy}
      onClick={(e) => {
        if (!isNativePlatform()) return;
        e.preventDefault();
        void updateInApp();
      }}
      className={className}
      style={style}
    >
      {progress === null ? children : `Downloading… ${Math.round(progress * 100)}%`}
    </a>
  );
}

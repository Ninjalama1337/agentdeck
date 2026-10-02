import { useState, type CSSProperties, type ReactNode } from 'react';
import type { ApkInfo } from '@agentdeck/shared';
import { api } from '../api/client';
import { errorMessage, useAppStore } from '../store/appStore';
import { downloadApkNatively } from '../util/download';
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
 * "open with installer" flow take over. Inside the APK the native downloader
 * saves it to Downloads instead — following the link there would open a
 * browser tab that stays behind after every update.
 */
export function ApkDownloadLink({ info, className, style, children }: Props) {
  const toast = useAppStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const href = api.apkLatestUrl();

  const downloadInApp = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const fileName = info.fileName ?? `AgentDeck${info.version ? `-${info.version}` : ''}.apk`;
      const saved = await downloadApkNatively(fileName, () => toast('info', 'Downloading the app update…'));
      if (saved) toast('info', 'Saved to Downloads — tap the download notification to install');
      else window.location.href = href;
    } catch (err) {
      toast('error', `Download failed: ${errorMessage(err)}`);
    } finally {
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
        void downloadInApp();
      }}
      className={className}
      style={style}
    >
      {children}
    </a>
  );
}

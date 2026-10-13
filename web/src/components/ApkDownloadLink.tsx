import { useState, type CSSProperties, type ReactNode } from 'react';
import type { ApkRelease } from '../util/apkRelease';
import { errorMessage, useAppStore } from '../store/appStore';
import { downloadApkNatively, installApkUpdate } from '../util/download';
import { isNativePlatform } from '../util/platform';

interface Props {
  release: ApkRelease;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/**
 * Download link for the latest Android build, hosted on the GitHub release.
 * In the browser/PWA it is a plain `<a download>` (the browser follows the
 * GitHub redirect), so the download manager and "open with installer" flow
 * take over. Inside the APK it updates the app in place: download with
 * progress, then Android's installer. APKs that cannot do that yet save the
 * file to Downloads instead — following the link there would open a browser
 * tab that stays behind after every update.
 */
export function ApkDownloadLink({ release, className, style, children }: Props) {
  const toast = useAppStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const fileName = `agentdeck-${release.version}.apk`;

  const updateInApp = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setProgress(0);
      if (await installApkUpdate(release.url, setProgress)) return;
      setProgress(null);
      const saved = await downloadApkNatively(release.url, fileName, () => toast('info', 'Downloading the app update…'));
      if (saved) toast('info', 'Saved to Downloads — open it there to install');
      else window.location.href = release.url;
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setProgress(null);
      setBusy(false);
    }
  };

  return (
    <a
      href={release.url}
      download={fileName}
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

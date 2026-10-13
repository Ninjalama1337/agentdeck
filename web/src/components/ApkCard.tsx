import { Download, Smartphone } from 'lucide-react';
import { clsx } from 'clsx';
import { ApkDownloadLink } from './ApkDownloadLink';
import type { ApkRelease } from '../util/apkRelease';
import { bytes, relTime } from '../util/format';
import { isNativePlatform } from '../util/platform';

/**
 * "Android app" card — rendered on the pairing screen and in settings. Offers
 * the latest APK from the public GitHub release (see ApkDownloadLink).
 * `release === null` means "not known yet" (still loading or GitHub
 * unreachable) and renders nothing.
 */
export function ApkCard({ release, className }: { release: ApkRelease | null; className?: string }) {
  if (!release) return null;

  const native = isNativePlatform();
  const details =
    [
      release.size ? bytes(release.size) : null,
      release.publishedAt ? `published ${relTime(Date.parse(release.publishedAt))}` : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'direct download from GitHub';

  return (
    <div
      className={clsx(
        'rounded-2xl border border-line bg-white/[0.04] p-3.5',
        className,
      )}
    >
      <div className="flex items-center gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white btn-primary"
        >
          <Smartphone size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold">
            Android app{release.version ? ` v${release.version}` : ''}
          </span>
          <span className="block truncate text-[11.5px] text-dim">{details}</span>
        </span>
      </div>

      <ApkDownloadLink
        release={release}
        className="press tap mt-3 flex w-full items-center justify-center gap-2 rounded-2xl text-[15px] font-semibold text-white"
        style={{ background: 'linear-gradient(135deg,#7C5CFF,#4E8CFF)', boxShadow: '0 8px 32px rgba(124,92,255,0.35)' }}
      >
        <Download size={16} />
        {native ? 'Download & install' : 'Download APK'}
      </ApkDownloadLink>
      <p className="mt-2 text-center text-[11.5px] text-dim">
        Allow install from unknown sources when prompted.
      </p>
    </div>
  );
}

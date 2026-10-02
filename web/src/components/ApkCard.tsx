import { Download, Smartphone } from 'lucide-react';
import type { ApkInfo } from '@agentdeck/shared';
import { clsx } from 'clsx';
import { ApkDownloadLink } from './ApkDownloadLink';
import { bytes, relTime } from '../util/format';
import { isNativePlatform } from '../util/platform';

/**
 * "Android app" card — rendered on the pairing screen and in settings.
 * Offers the latest APK for download (see ApkDownloadLink). `info === null`
 * means "not known yet" (still loading or server unreachable) and renders
 * nothing; `available: false` degrades to a subtle one-liner pointing at the
 * PWA.
 */
export function ApkCard({ info, className }: { info: ApkInfo | null; className?: string }) {
  if (!info) return null;

  if (!info.available) {
    return (
      <p className={clsx('flex items-start gap-2 text-[12.5px] leading-relaxed text-dim', className)}>
        <Smartphone size={14} className="mt-0.5 shrink-0 opacity-70" />
        No APK uploaded yet — the server serves this page as an installable PWA in the meantime.
      </p>
    );
  }

  const native = isNativePlatform();

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
            Android app{info.version ? ` v${info.version}` : ''}
          </span>
          <span className="block truncate text-[11.5px] text-dim">
            {[
              info.size ? bytes(info.size) : null,
              info.builtAt ? `built ${relTime(info.builtAt)}` : null,
            ]
              .filter(Boolean)
              .join(' · ') || 'direct download'}
          </span>
        </span>
        {info.channel && (
          <span
            className={clsx(
              'shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide',
              info.channel === 'release'
                ? 'border-ok/30 bg-ok/12 text-ok'
                : 'border-line bg-white/[0.06] text-dim',
            )}
          >
            {info.channel}
          </span>
        )}
      </div>

      <ApkDownloadLink
        info={info}
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

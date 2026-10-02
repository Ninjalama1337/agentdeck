import { useEffect, useRef, useState } from 'react';
import { ArrowUpCircle, Check, Loader2, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';
import { useAppStore } from '../../store/appStore';
import { relTime } from '../../util/format';

/**
 * Server self-update: the version this server runs, the latest GitHub
 * release, and one tap to move the server onto it. The server fast-forwards
 * its checkout, builds, fetches the release APK and restarts — the socket
 * drops for a moment and the app reconnects to the new version.
 */
export function ServerUpdateSection() {
  const update = useAppStore((s) => s.update);
  const connection = useAppStore((s) => s.connection);
  const refreshUpdate = useAppStore((s) => s.refreshUpdate);
  const startUpdate = useAppStore((s) => s.startUpdate);
  const [checking, setChecking] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const consoleRef = useRef<HTMLPreElement | null>(null);

  // One-shot refresh when settings opens (the server caches the GitHub answer).
  useEffect(() => {
    void refreshUpdate();
  }, [refreshUpdate]);

  const job = update?.job;
  const lines = job?.output ?? [];
  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  // Servers older than this feature have no /api/update — nothing to offer.
  if (!update) return null;

  const running = job?.status === 'running';
  // A finished job on a server that is about to restart (or is restarting).
  const restarting = job?.status === 'done' || (running && connection !== 'online');
  const latest = update.latest;

  const check = async () => {
    setChecking(true);
    await refreshUpdate(true);
    setChecking(false);
  };

  const run = () => {
    if (!confirm) {
      setConfirm(true);
      window.setTimeout(() => setConfirm(false), 4000);
      return;
    }
    setConfirm(false);
    void startUpdate();
  };

  let status: { text: string; tone: 'ok' | 'accent' | 'warn' | 'dim' };
  if (running || restarting) {
    status = { text: restarting ? `Restarting on v${job?.target}…` : `Updating to v${job?.target}…`, tone: 'accent' };
  } else if (update.blockedReason) {
    status = { text: update.blockedReason, tone: 'dim' };
  } else if (update.checkError) {
    status = { text: update.checkError, tone: 'warn' };
  } else if (update.updateAvailable && latest) {
    status = {
      text: `v${latest.version} available${latest.publishedAt ? ` · released ${relTime(Date.parse(latest.publishedAt))}` : ''}`,
      tone: 'accent',
    };
  } else if (latest) {
    status = { text: 'Up to date with the latest release', tone: 'ok' };
  } else {
    status = { text: 'No release published yet', tone: 'dim' };
  }

  return (
    <section className="glass mb-4 p-4" aria-label="Server update">
      <h2 className="mb-3 flex items-center gap-2 text-[14px] font-semibold">
        <ArrowUpCircle size={15} className="text-accent" /> Server update
      </h2>

      <div className="flex items-center gap-3 rounded-xl border border-line bg-white/[0.04] px-3 py-2.5">
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] uppercase tracking-wider text-dim">Installed version</span>
          <span className="block truncate font-mono text-[12.5px] text-ink">v{update.current}</span>
          <span
            className={clsx(
              'mt-0.5 flex items-center gap-1 text-[12px] leading-snug',
              status.tone === 'ok' && 'text-ok',
              status.tone === 'accent' && 'text-accent',
              status.tone === 'warn' && 'text-warn',
              status.tone === 'dim' && 'text-dim',
            )}
          >
            {status.tone === 'ok' && <Check size={13} className="shrink-0" />}
            {(running || restarting) && <Loader2 size={13} className="shrink-0 animate-spin" />}
            {status.text}
          </span>
        </span>
        <button
          type="button"
          aria-label="Check for a newer release"
          disabled={checking || running}
          onClick={() => void check()}
          className="press tap flex h-10 shrink-0 items-center gap-1.5 rounded-[14px] border border-line bg-white/[0.06] px-3 text-[13px] font-medium active:bg-white/[0.1] disabled:opacity-40"
        >
          <RefreshCw size={14} className={clsx(checking && 'animate-spin')} />
          Check
        </button>
      </div>

      {update.updateAvailable && latest && !running && !restarting && !update.blockedReason && (
        <button
          type="button"
          onClick={run}
          className={clsx(
            'press tap mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border text-[14.5px] font-semibold',
            confirm ? 'border-accent bg-accent text-white' : 'border-accent/40 bg-accent/15 text-accent',
          )}
        >
          <ArrowUpCircle size={16} />
          {confirm ? 'Tap again — the server restarts' : `Update server to v${latest.version}`}
        </button>
      )}

      {job && lines.length > 0 && (
        <pre
          ref={consoleRef}
          aria-label="Update output"
          className={clsx(
            'mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl border px-3 py-2 font-mono text-[11px] leading-relaxed',
            job.status === 'error' ? 'border-danger/30 bg-danger/5 text-ink' : 'border-line bg-black/30 text-dim',
          )}
        >
          {lines.join('\n')}
        </pre>
      )}
      {job?.status === 'error' && job.error && (
        <p className="mt-2 text-[12.5px] leading-snug text-danger" role="alert">
          {job.error}
        </p>
      )}

      <p className="mt-2.5 text-[11.5px] leading-relaxed text-dim">
        Updates come from GitHub releases. The server builds the release, picks up its Android app and restarts —
        terminals keep running.
        {update.checkedAt ? ` Last checked ${relTime(update.checkedAt)}.` : ''}
      </p>
    </section>
  );
}

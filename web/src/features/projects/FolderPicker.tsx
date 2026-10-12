import { useEffect, useState } from 'react';
import { ChevronRight, CornerUpLeft, Folder, FolderGit2, HardDrive, Loader2 } from 'lucide-react';
import type { BrowseResponse } from '@agentdeck/shared';
import { api } from '../../api/client';
import { errorMessage } from '../../store/appStore';

function baseName(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

/** Server-directory picker: navigate the filesystem and adopt a folder as a project. */
export function FolderPicker({ onPick }: { onPick: (path: string, name: string) => void }) {
  const [path, setPath] = useState<string | undefined>(undefined);
  const [showHidden, setShowHidden] = useState(false);
  const [data, setData] = useState<BrowseResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .browseFs(path, showHidden)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, showHidden]);

  const current = data?.path;
  const canGoUp = Boolean(data?.parent);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 rounded-2xl border border-line bg-white/[0.04] px-3 py-2">
        <button
          type="button"
          disabled={!canGoUp}
          onClick={() => data?.parent && setPath(data.parent)}
          className="press tap flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-dim disabled:opacity-30"
          aria-label="Up one level"
        >
          <CornerUpLeft size={15} />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-dim" title={current}>
          {current ?? '…'}
        </span>
        <button
          type="button"
          onClick={() => setShowHidden((v) => !v)}
          className="press tap shrink-0 rounded-xl px-2 py-1 text-[11px] text-dim"
        >
          {showHidden ? 'Hide hidden' : 'Show hidden'}
        </button>
      </div>

      {error && (
        <p className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-[13px] text-danger" role="alert">
          {error}
        </p>
      )}

      <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
        {loading && data === null && <p className="py-4 text-center text-[13px] text-dim">Loading folders…</p>}
        {(data?.entries ?? []).map((entry) => (
          <div
            key={entry.path}
            className="flex items-center gap-1 rounded-2xl border border-line bg-white/[0.04] pl-3.5 pr-1.5"
          >
            <button
              type="button"
              onClick={() => setPath(entry.path)}
              className="press tap flex min-w-0 flex-1 items-center gap-3 py-2.5 text-left"
            >
              {entry.isGitRepo ? (
                <FolderGit2 size={17} className="shrink-0 text-accent" />
              ) : (
                <Folder size={17} className="shrink-0 text-dim" />
              )}
              <span className="min-w-0 flex-1 truncate text-[13.5px]">{entry.name}</span>
              <ChevronRight size={15} className="shrink-0 text-dim" />
            </button>
            {entry.isGitRepo && (
              <button
                type="button"
                onClick={() => onPick(entry.path, entry.name)}
                className="press tap shrink-0 rounded-xl bg-accent/15 px-3 py-1.5 text-[12px] font-medium text-accent"
              >
                Use
              </button>
            )}
          </div>
        ))}
        {data !== null && data.entries.length === 0 && !loading && (
          <p className="py-4 text-center text-[13px] text-dim">No subfolders here.</p>
        )}
      </div>

      <button
        type="button"
        disabled={!current || loading}
        onClick={() => current && onPick(current, baseName(current))}
        className="press tap flex items-center justify-center gap-2 rounded-2xl text-[15px] font-semibold text-white disabled:opacity-40 btn-primary"
      >
        {loading ? <Loader2 size={16} className="animate-spin" /> : <HardDrive size={16} />}
        Use “{current ? baseName(current) : '…'}”
      </button>
    </div>
  );
}

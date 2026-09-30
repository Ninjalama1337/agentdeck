import { useEffect, useState } from 'react';
import { AlertTriangle, Lock, Search } from 'lucide-react';
import type { GithubRepo } from '@agentdeck/shared';
import { api, ApiError } from '../../api/client';
import { useDebounced } from '../../hooks/useDebounced';
import { langColor, relTime } from '../../util/format';

/** Searchable list of the user's GitHub repos (server-side via `gh`). */
export function RepoPicker({ onPick }: { onPick: (repo: GithubRepo) => void }) {
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query, 400);
  const [repos, setRepos] = useState<GithubRepo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .githubRepos(debounced.trim() || undefined, 20)
      .then((list) => {
        if (!cancelled) {
          setRepos(list);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setRepos(null);
          setError({
            status: err instanceof ApiError ? err.status : 0,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  if (error && error.status === 503) {
    return (
      <div className="flex items-start gap-2.5 rounded-xl border border-warn/30 bg-warn/10 p-3.5 text-[13px] leading-relaxed text-warn">
        <AlertTriangle size={15} className="mt-0.5 shrink-0" />
        <p>
          GitHub CLI (<span className="font-mono">gh</span>) is not available or not signed in on the
          AgentDeck server — install and authenticate it to browse your repositories.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="relative mb-2">
        <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-dim" />
        <input
          className="field pl-10"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your repositories…"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {loading && repos === null && <p className="py-4 text-center text-[13px] text-dim">Loading repositories…</p>}
      {error && (
        <p className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-[13px] text-danger" role="alert">
          {error.message}
        </p>
      )}

      <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
        {(repos ?? []).map((repo) => {
          const owner = repo.nameWithOwner.split('/')[0] ?? repo.nameWithOwner;
          return (
            <button
              key={repo.nameWithOwner}
              type="button"
              onClick={() => onPick(repo)}
              className="press tap flex items-center gap-3 rounded-2xl border border-line bg-white/[0.04] px-3.5 py-2.5 text-left active:bg-white/[0.08]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`https://github.com/${owner}.png?size=64`}
                alt=""
                loading="lazy"
                className="h-8 w-8 shrink-0 rounded-lg bg-white/10 object-cover"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[13.5px] font-medium">{repo.nameWithOwner}</span>
                  {repo.isPrivate && <Lock size={11} className="shrink-0 text-warn" aria-label="Private" />}
                </span>
                <span className="mt-0.5 flex items-center gap-2 text-[11.5px] text-dim">
                  {repo.language && (
                    <span className="inline-flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full" style={{ background: langColor(repo.language) }} />
                      {repo.language}
                    </span>
                  )}
                  {repo.updatedAt && <span>Updated {relTime(repo.updatedAt)}</span>}
                </span>
              </span>
            </button>
          );
        })}
        {repos !== null && repos.length === 0 && !loading && (
          <p className="py-4 text-center text-[13px] text-dim">No repositories found.</p>
        )}
      </div>
    </div>
  );
}

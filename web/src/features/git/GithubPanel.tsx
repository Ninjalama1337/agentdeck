import { useCallback, useEffect, useState } from 'react';
import { Bot, CircleDot, ExternalLink, GitPullRequest, Loader2, MessageSquare, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';
import type { GithubItem, GithubItemDetail } from '@agentdeck/shared';
import { api } from '../../api/client';
import { errorMessage } from '../../store/appStore';
import { Sheet } from '../../components/ui/Sheet';
import { MarkdownView } from '../../components/ui/Markdown';
import { SendPromptSheet } from '../../components/SendPromptSheet';
import { openExternal } from '../../util/openExternal';
import { relTime } from '../../util/format';
import { githubPrompt } from './githubPrompt';

/**
 * Open issues and PRs of the project's GitHub repo (after Orca's GitHub view):
 * read them, and hand one to an agent — new, in parallel worktrees, or running.
 */
export function GithubPanel({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<GithubItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'issue' | 'pr'>('all');
  const [open, setOpen] = useState<GithubItem | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .githubItems(projectId)
      .then(setItems)
      .catch((err) => {
        setItems([]);
        setError(errorMessage(err));
      });
  }, [projectId]);

  useEffect(() => {
    setItems(null);
    load();
  }, [load]);

  const shown = (items ?? []).filter((i) => filter === 'all' || i.kind === filter);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {(['all', 'issue', 'pr'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={clsx('press rounded-full border px-3 py-1 text-[12px] font-medium', filter === f ? 'border-accent/50 bg-accent/15 text-ink' : 'border-line text-dim')}
          >
            {f === 'all' ? 'All' : f === 'issue' ? 'Issues' : 'Pull requests'}
          </button>
        ))}
        <span className="flex-1" />
        <button type="button" aria-label="Refresh" onClick={load} className="press flex h-8 w-8 items-center justify-center rounded-lg text-dim">
          <RefreshCw size={14} />
        </button>
      </div>
      {items === null ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-14" />
          ))}
        </div>
      ) : error ? (
        <p className="glass p-4 text-[13px] text-dim">{error}</p>
      ) : shown.length === 0 ? (
        <p className="glass p-4 text-center text-[13px] text-dim">Nothing open.</p>
      ) : (
        <ul className="glass overflow-hidden p-0">
          {shown.map((i) => (
            <li key={`${i.kind}${i.number}`} className="border-b border-line last:border-0">
              <button type="button" onClick={() => setOpen(i)} className="press flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left active:bg-white/[0.04]">
                {i.kind === 'pr' ? (
                  <GitPullRequest size={16} className={clsx('mt-0.5 shrink-0', i.draft ? 'text-dim' : 'text-ok')} />
                ) : (
                  <CircleDot size={16} className="mt-0.5 shrink-0 text-ok" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-medium leading-snug">
                    {i.title} <span className="font-normal text-dim">#{i.number}</span>
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-dim">
                    {i.author && <span>{i.author}</span>}
                    {i.updatedAt && <span>{relTime(Date.parse(i.updatedAt))}</span>}
                    {i.headRef && <span className="font-mono">{i.headRef}</span>}
                    {i.comments ? (
                      <span className="inline-flex items-center gap-0.5">
                        <MessageSquare size={10} /> {i.comments}
                      </span>
                    ) : null}
                    {i.labels.map((l) => (
                      <span key={l} className="rounded-full border border-line px-1.5 text-[10.5px]">
                        {l}
                      </span>
                    ))}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <GithubItemSheet projectId={projectId} item={open} onClose={() => setOpen(null)} />
    </section>
  );
}

function GithubItemSheet({ projectId, item, onClose }: { projectId: string; item: GithubItem | null; onClose: () => void }) {
  const [detail, setDetail] = useState<GithubItemDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setDetail(null);
    setError(null);
    if (!item) return;
    api
      .githubItem(projectId, item.kind, item.number)
      .then(setDetail)
      .catch((err) => setError(errorMessage(err)));
  }, [projectId, item]);

  return (
    <>
      <Sheet open={item !== null && !sending} onClose={onClose} title={item ? `${item.kind === 'pr' ? 'PR' : 'Issue'} #${item.number}` : undefined} subtitle={item?.title}>
        {error ? (
          <p className="text-[13px] text-danger">{error}</p>
        ) : !detail ? (
          <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-dim">
            <Loader2 size={15} className="animate-spin" /> Loading…
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setSending(true)}
                className="press btn-primary flex h-10 items-center justify-center gap-1.5 rounded-xl text-[13px] font-semibold text-white"
              >
                <Bot size={15} /> {detail.kind === 'pr' ? 'Review with agent' : 'Hand to agent'}
              </button>
              <button
                type="button"
                onClick={() => openExternal(detail.url)}
                className="press flex h-10 items-center justify-center gap-1.5 rounded-xl border border-line text-[13px] font-medium"
              >
                <ExternalLink size={14} /> GitHub
              </button>
            </div>
            <div className="rounded-xl border border-line bg-black/20 px-3.5 py-3 text-[13.5px]">
              {detail.body.trim() ? <MarkdownView text={detail.body} /> : <p className="text-dim">No description.</p>}
            </div>
            {detail.thread.map((c, i) => (
              <div key={i} className="rounded-xl border border-line bg-white/[0.02] px-3.5 py-2.5 text-[13px]">
                <p className="mb-1 text-[11.5px] text-dim">
                  {c.author ?? 'someone'}
                  {c.createdAt ? ` · ${relTime(Date.parse(c.createdAt))}` : ''}
                </p>
                <MarkdownView text={c.body} />
              </div>
            ))}
          </div>
        )}
      </Sheet>
      {detail && (
        <SendPromptSheet
          projectId={projectId}
          prompt={githubPrompt(detail)}
          title={`${detail.kind === 'pr' ? 'PR' : 'Issue'} #${detail.number}: ${detail.title}`}
          open={sending}
          onClose={() => {
            setSending(false);
            onClose();
          }}
        />
      )}
    </>
  );
}

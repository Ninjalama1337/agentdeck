import { Fragment, useMemo, useState } from 'react';
import { MessageSquarePlus, Pencil, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import { diffLineRefs, lineKey, useReviewComments, type DiffLineRef, type ReviewComment } from './reviewComments';

const PAGE = 1500;
const NO_COMMENTS: ReviewComment[] = [];

/**
 * Colored unified diff (add/del/hunk/meta lines), paged for huge diffs. With a
 * `projectId`, tapping a code line adds a review comment there (see reviewComments.ts).
 */
export function DiffView({ diff, truncated, projectId }: { diff: string; truncated?: boolean; projectId?: string }) {
  const lines = useMemo(() => diff.replace(/\n$/, '').split('\n'), [diff]);
  const refs = useMemo(() => diffLineRefs(lines), [lines]);
  const [limit, setLimit] = useState(PAGE);
  /** Line index being commented on, or the id of a comment being edited. */
  const [editing, setEditing] = useState<{ index: number; commentId?: string } | null>(null);
  const comments = useReviewComments((s) => (projectId ? (s.byProject[projectId] ?? NO_COMMENTS) : NO_COMMENTS));

  const byLine = useMemo(() => {
    const map = new Map<string, ReviewComment[]>();
    for (const c of comments) {
      const key = `${c.file}\u0000${c.line}`;
      map.set(key, [...(map.get(key) ?? []), c]);
    }
    return map;
  }, [comments]);

  if (!diff.trim()) return <p className="py-6 text-center text-[13px] text-dim">No textual changes.</p>;

  const keyOf = (ref: DiffLineRef): string | null => {
    const line = lineKey(ref);
    return line && ref.file ? `${ref.file}\u0000${line}` : null;
  };

  return (
    <div>
      {projectId && (
        <p className="mb-2 flex items-center gap-1.5 text-[11.5px] text-dim">
          <MessageSquarePlus size={13} /> Tap a line to leave a comment for the agent.
        </p>
      )}
      <div className="diff">
        {lines.slice(0, limit).map((line, i) => {
          const ref = refs[i]!;
          const key = projectId ? keyOf(ref) : null;
          const here = key ? (byLine.get(key) ?? NO_COMMENTS) : NO_COMMENTS;
          return (
            <Fragment key={i}>
              <div
                className={clsx(
                  ref.kind === 'meta' || ref.kind === 'hunk' ? ref.kind : ref.kind === 'context' ? undefined : ref.kind,
                  key && 'cursor-pointer active:brightness-125',
                  here.length > 0 && 'commented',
                )}
                onClick={key ? () => setEditing({ index: i }) : undefined}
              >
                {line || ' '}
              </div>
              {projectId &&
                here.map((c) =>
                  editing?.commentId === c.id ? (
                    <CommentEditor
                      key={c.id}
                      initial={c.text}
                      onSave={(text) => {
                        useReviewComments.getState().update(projectId, c.id, text);
                        setEditing(null);
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  ) : (
                    <div key={c.id} className="review-note">
                      <span className="min-w-0 flex-1 whitespace-pre-wrap">{c.text}</span>
                      <button type="button" aria-label="Edit comment" onClick={() => setEditing({ index: i, commentId: c.id })} className="press p-1 text-dim">
                        <Pencil size={12} />
                      </button>
                      <button
                        type="button"
                        aria-label="Delete comment"
                        onClick={() => useReviewComments.getState().remove(projectId, c.id)}
                        className="press p-1 text-dim"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ),
                )}
              {projectId && editing?.index === i && !editing.commentId && ref.file && (
                <CommentEditor
                  onSave={(text) => {
                    useReviewComments.getState().add(projectId, { file: ref.file!, line: lineKey(ref)!, code: line, text });
                    setEditing(null);
                  }}
                  onCancel={() => setEditing(null)}
                />
              )}
            </Fragment>
          );
        })}
      </div>
      {lines.length > limit && (
        <button
          type="button"
          onClick={() => setLimit((l) => l + PAGE)}
          className="press tap mt-2 w-full rounded-2xl border border-line text-[13px] font-medium text-dim"
        >
          Show {Math.min(PAGE, lines.length - limit)} more lines
        </button>
      )}
      {truncated && <p className="mt-2 text-center text-[12px] text-warn">Diff truncated by the server.</p>}
    </div>
  );
}

function CommentEditor({ initial = '', onSave, onCancel }: { initial?: string; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  return (
    <div className="review-editor" onClick={(e) => e.stopPropagation()}>
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim()) onSave(text.trim());
          if (e.key === 'Escape') onCancel();
        }}
        rows={2}
        placeholder="What should the agent change here?"
        className="w-full resize-y rounded-lg border border-line bg-black/30 px-2.5 py-2 font-sans text-[13px] leading-snug text-ink outline-none placeholder:text-dim/60 focus:border-accent/50"
      />
      <div className="mt-1.5 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="press rounded-lg px-3 py-1.5 font-sans text-[12.5px] text-dim">
          Cancel
        </button>
        <button
          type="button"
          disabled={!text.trim()}
          onClick={() => onSave(text.trim())}
          className="press btn-primary rounded-lg px-3 py-1.5 font-sans text-[12.5px] font-semibold text-white disabled:opacity-50"
        >
          Save comment
        </button>
      </div>
    </div>
  );
}

/** +/- counts of a unified diff. */
export function diffStats(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) add++;
    else if (line.startsWith('-') && !line.startsWith('---')) del++;
  }
  return { add, del };
}

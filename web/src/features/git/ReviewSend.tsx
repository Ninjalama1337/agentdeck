import { useState } from 'react';
import { MessageSquareText, Send, Trash2 } from 'lucide-react';
import type { ReviewComment } from './reviewComments';
import { commentLocation, reviewPrompt, useReviewComments } from './reviewComments';
import { useAppStore } from '../../store/appStore';
import { SendPromptSheet } from '../../components/SendPromptSheet';

const NO_COMMENTS: ReviewComment[] = [];

function plural(n: number): string {
  return `${n} review ${n === 1 ? 'comment' : 'comments'}`;
}

/** "3 review comments · Send to agent" — shown while a project has unsent comments. */
export function ReviewSendBar({ projectId }: { projectId: string }) {
  const comments = useReviewComments((s) => s.byProject[projectId] ?? NO_COMMENTS);
  const [open, setOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  if (comments.length === 0) return null;
  return (
    <>
      <div className="glass flex items-center gap-2 p-2 pl-3.5">
        <MessageSquareText size={16} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 text-[13px] font-medium">{plural(comments.length)}</span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="press btn-primary flex h-9 items-center gap-1.5 rounded-xl px-3.5 text-[13px] font-semibold text-white"
        >
          <Send size={14} /> Send to agent
        </button>
      </div>
      {/* The same hand-over as for GitHub issues: a new agent, parallel worktrees, or a running terminal/chat. */}
      <SendPromptSheet
        projectId={projectId}
        prompt={reviewPrompt(comments)}
        title={`${plural(comments.length)} as one prompt`}
        open={open}
        onClose={() => {
          setOpen(false);
          setConfirmClear(false);
        }}
        onSent={() => {
          useReviewComments.getState().clear(projectId);
          useAppStore.getState().toast('info', 'Review sent');
        }}
      >
        <ul className="mb-2 flex flex-col gap-1.5">
          {comments.map((c) => (
            <li key={c.id} className="flex items-start gap-2 rounded-xl border border-line bg-white/[0.03] px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[11px] text-dim">{commentLocation(c)}</span>
                <span className="block whitespace-pre-wrap text-[13px]">{c.text}</span>
              </span>
              <button
                type="button"
                aria-label="Delete comment"
                onClick={() => useReviewComments.getState().remove(projectId, c.id)}
                className="press p-1 text-dim"
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => {
            if (!confirmClear) return setConfirmClear(true);
            useReviewComments.getState().clear(projectId);
            setOpen(false);
          }}
          className="press mb-3 text-[12px] font-medium text-danger"
        >
          {confirmClear ? 'Tap again to delete all comments' : 'Discard all comments'}
        </button>
      </SendPromptSheet>
    </>
  );
}

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, MessageSquareText, Send, SquareTerminal, Trash2 } from 'lucide-react';
import type { ReviewComment } from './reviewComments';
import { commentLocation, reviewPrompt, useReviewComments } from './reviewComments';
import { errorMessage, useAppStore } from '../../store/appStore';
import { Sheet } from '../../components/ui/Sheet';
import { sendText } from '../code/termInput';

const NO_COMMENTS: ReviewComment[] = [];

/** "3 review comments · Send to agent" — shown while a project has unsent comments. */
export function ReviewSendBar({ projectId }: { projectId: string }) {
  const comments = useReviewComments((s) => s.byProject[projectId] ?? NO_COMMENTS);
  const [open, setOpen] = useState(false);
  if (comments.length === 0) return null;
  return (
    <>
      <div className="glass flex items-center gap-2 p-2 pl-3.5">
        <MessageSquareText size={16} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 text-[13px] font-medium">
          {comments.length} review {comments.length === 1 ? 'comment' : 'comments'}
        </span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="press btn-primary flex h-9 items-center gap-1.5 rounded-xl px-3.5 text-[13px] font-semibold text-white"
        >
          <Send size={14} /> Send to agent
        </button>
      </div>
      <ReviewSendSheet projectId={projectId} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function ReviewSendSheet({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const comments = useReviewComments((s) => s.byProject[projectId] ?? NO_COMMENTS);
  const allTerminals = useAppStore((s) => s.terminals);
  const terminals = useMemo(() => allTerminals.filter((t) => t.projectId === projectId), [allTerminals, projectId]);
  const presets = useAppStore((s) => s.terminalPresets);
  const sessions = useAppStore((s) => s.sessionsByProject[projectId]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const prompt = reviewPrompt(comments);
  const recentSessions = [...(sessions ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);

  const done = (target: string) => {
    useReviewComments.getState().clear(projectId);
    onClose();
    useAppStore.getState().toast('info', 'Review sent');
    useAppStore.getState().openTarget(target);
  };

  const toTerminal = (id: string) => {
    sendText(id, prompt);
    done(`terminal:${id}`);
  };

  const toSession = async (id: string) => {
    try {
      await useAppStore.getState().sendTurn(id, prompt, []);
      done(`session:${id}`);
    } catch (err) {
      useAppStore.getState().toast('error', errorMessage(err));
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Send review" subtitle={`${comments.length} comments as one prompt`}>
      <ul className="mb-3 flex flex-col gap-1.5">
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

      <button type="button" onClick={() => setPreviewOpen((v) => !v)} className="press mb-2 flex items-center gap-1 text-[12px] font-medium text-dim">
        {previewOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Prompt preview
      </button>
      {previewOpen && (
        <pre className="no-scrollbar mb-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-dim">
          {prompt}
        </pre>
      )}

      <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-dim">Send to</p>
      {terminals.length === 0 && recentSessions.length === 0 && (
        <p className="mb-3 text-[12.5px] text-dim">No terminal or chat in this project yet — start an agent in the Code tab first.</p>
      )}
      <div className="flex flex-col gap-1.5">
        {terminals.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => toTerminal(t.id)}
            className="press tap flex items-center gap-2.5 rounded-xl border border-line bg-white/[0.04] px-3 py-2.5 text-left"
          >
            <SquareTerminal size={16} className="shrink-0" style={{ color: presets?.find((p) => p.id === t.presetId)?.accent ?? '#99A1B3' }} />
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{t.title ?? 'shell'}</span>
            <span className="text-[11px] text-dim">terminal</span>
          </button>
        ))}
        {recentSessions.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => void toSession(s.id)}
            className="press tap flex items-center gap-2.5 rounded-xl border border-line bg-white/[0.04] px-3 py-2.5 text-left"
          >
            <MessageSquareText size={16} className="shrink-0 text-dim" />
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{s.title || 'Chat'}</span>
            <span className="text-[11px] text-dim">chat</span>
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => {
          if (!confirmClear) return setConfirmClear(true);
          useReviewComments.getState().clear(projectId);
          onClose();
        }}
        className="press mt-4 w-full rounded-xl py-2 text-[12.5px] font-medium text-danger"
      >
        {confirmClear ? 'Tap again to delete all comments' : 'Discard all comments'}
      </button>
    </Sheet>
  );
}

import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, GitFork, MessageSquareText, Play, SquareTerminal } from 'lucide-react';
import { errorMessage, useAppStore } from '../store/appStore';
import { usePrefs } from '../store/prefs';
import { Sheet } from './ui/Sheet';
import { sendText, estimateSize } from '../features/code/termInput';
import { PresetGlyph } from '../features/code/Launcher';
import { openParallel } from '../features/code/ParallelSheet';

/**
 * Hands a ready prompt to an agent: start a new one with it, run it in
 * parallel worktrees, or send it to a terminal or chat of the project.
 */
export function SendPromptSheet({
  projectId,
  prompt,
  title,
  open,
  onClose,
  onSent,
  children,
}: {
  projectId: string;
  prompt: string;
  title: string;
  open: boolean;
  onClose: () => void;
  /** The prompt went to an agent (not on close, not when handed to the parallel sheet). */
  onSent?: () => void;
  /** Shown above the choices (e.g. the review comments). */
  children?: ReactNode;
}) {
  const allTerminals = useAppStore((s) => s.terminals);
  const presets = useAppStore((s) => s.terminalPresets);
  const sessions = useAppStore((s) => s.sessionsByProject[projectId]);
  const [preview, setPreview] = useState(false);
  // Only agent terminals take a prompt — a shell or dev server would run it as a command.
  const terminals = useMemo(
    () => allTerminals.filter((t) => t.projectId === projectId && presets?.some((p) => p.id === t.presetId && p.kind === 'agent')),
    [allTerminals, presets, projectId],
  );
  const starters = useMemo(() => (presets ?? []).filter((p) => p.kind === 'agent' && p.available && p.promptArg), [presets]);
  const chats = [...(sessions ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);

  const done = (target: string) => {
    onSent?.();
    onClose();
    useAppStore.getState().openTarget(target);
  };

  const startNew = async (presetId: string) => {
    const store = useAppStore.getState();
    try {
      const { cols, rows } = estimateSize(usePrefs.getState().termFontSize);
      const term = await store.createTerminal(projectId, cols, rows, { presetId, prompt });
      done(`terminal:${term.id}`);
    } catch (err) {
      store.toast('error', errorMessage(err));
    }
  };

  const toChat = async (id: string) => {
    try {
      await useAppStore.getState().sendTurn(id, prompt, []);
      done(`session:${id}`);
    } catch (err) {
      useAppStore.getState().toast('error', errorMessage(err));
    }
  };

  const row = 'press tap flex w-full items-center gap-2.5 rounded-xl border border-line bg-white/[0.04] px-3 py-2.5 text-left';

  return (
    <Sheet open={open} onClose={onClose} title="Hand to an agent" subtitle={title}>
      {children}
      <button type="button" onClick={() => setPreview((v) => !v)} className="press mb-2 flex items-center gap-1 text-[12px] font-medium text-dim">
        {preview ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Prompt
      </button>
      {preview && (
        <pre className="no-scrollbar mb-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-dim">
          {prompt}
        </pre>
      )}

      {starters.length > 0 && (
        <>
          <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-dim">Start a new agent</p>
          <div className="mb-3 flex flex-col gap-1.5">
            {starters.map((p) => (
              <button key={p.id} type="button" onClick={() => void startNew(p.id)} className={row}>
                <PresetGlyph preset={p} size={26} />
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{p.label}</span>
                <Play size={14} className="text-dim" />
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                onClose();
                openParallel(prompt);
              }}
              className={row}
            >
              <GitFork size={16} className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">Several agents in parallel worktrees…</span>
            </button>
          </div>
        </>
      )}

      {(terminals.length > 0 || chats.length > 0) && (
        <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-wide text-dim">Or send to</p>
      )}
      <div className="flex flex-col gap-1.5">
        {terminals.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              sendText(t.id, prompt);
              done(`terminal:${t.id}`);
            }}
            className={row}
          >
            <SquareTerminal size={16} className="shrink-0" style={{ color: presets?.find((p) => p.id === t.presetId)?.accent ?? '#99A1B3' }} />
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{t.title ?? 'shell'}</span>
            <span className="text-[11px] text-dim">terminal</span>
          </button>
        ))}
        {chats.map((s) => (
          <button key={s.id} type="button" onClick={() => void toChat(s.id)} className={row}>
            <MessageSquareText size={16} className="shrink-0 text-dim" />
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{s.title || 'Chat'}</span>
            <span className="text-[11px] text-dim">chat</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

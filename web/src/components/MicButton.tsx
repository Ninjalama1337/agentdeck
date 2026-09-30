import { Loader2, Mic, Square } from 'lucide-react';
import { clsx } from 'clsx';
import type { Dictation } from '../hooks/useDictation';

/** Mic toggle with a live "recording" ring; hides itself when no engine exists. */
export function MicButton({ dictation, size = 44, className }: { dictation: Dictation; size?: number; className?: string }) {
  if (!dictation.supported) return null;
  const active = dictation.state === 'listening' || dictation.state === 'recording';
  const busy = dictation.state === 'transcribing';
  return (
    <button
      type="button"
      aria-label={active ? 'Stop dictation' : busy ? 'Transcribing' : 'Dictate'}
      aria-pressed={active}
      onClick={dictation.toggle}
      className={clsx(
        'press relative flex shrink-0 items-center justify-center rounded-full transition-colors',
        active ? 'bg-danger text-white' : busy ? 'bg-accent/20 text-accent' : 'text-dim active:bg-white/10 active:text-ink',
        className,
      )}
      style={{ width: size, height: size }}
    >
      {active && <span aria-hidden className="mic-ring absolute inset-0 rounded-full" />}
      {busy ? <Loader2 size={18} className="animate-spin" /> : active ? <Square size={14} fill="currentColor" /> : <Mic size={19} />}
    </button>
  );
}

/** Live transcript / recording indicator shown above an input. */
export function DictationHint({ dictation }: { dictation: Dictation }) {
  if (dictation.state === 'idle') return null;
  const text =
    dictation.state === 'transcribing'
      ? 'Transcribing…'
      : dictation.state === 'recording'
        ? `Recording ${Math.floor(dictation.seconds / 60)}:${String(dictation.seconds % 60).padStart(2, '0')} — tap ■ to finish`
        : dictation.interim || 'Listening…';
  return (
    <div className="mb-2 flex items-center gap-2 rounded-2xl border border-danger/25 bg-danger/10 px-3.5 py-2 text-[13px] text-ink">
      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-danger" />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {dictation.state !== 'transcribing' && (
        <button type="button" onClick={dictation.cancel} className="press shrink-0 text-[12px] font-semibold text-dim">
          Cancel
        </button>
      )}
    </div>
  );
}

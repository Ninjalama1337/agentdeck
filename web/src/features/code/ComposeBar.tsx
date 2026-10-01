import { useEffect, useRef, useState } from 'react';
import { ArrowUp, CornerDownLeft } from 'lucide-react';
import { clsx } from 'clsx';
import { DictationHint, MicButton } from '../../components/MicButton';
import { useDictation } from '../../hooks/useDictation';
import { useAppStore } from '../../store/appStore';
import { haptic } from '../../util/haptics';

interface Props {
  placeholder: string;
  disabled?: boolean;
  onSend: (text: string) => void;
}

const HISTORY_LIMIT = 40;
const history: string[] = [];

/**
 * Phone-friendly line editor for terminals: autocorrect, dictation and
 * multi-line prompts, sent to the PTY as one message. Empty send = Enter.
 */
export function ComposeBar({ placeholder, disabled, onSend }: Props) {
  const toast = useAppStore((s) => s.toast);
  const [text, setText] = useState('');
  const [histIdx, setHistIdx] = useState(-1);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const dictation = useDictation(
    (spoken) => setText((t) => (t && !/\s$/.test(t) ? `${t} ${spoken}` : `${t}${spoken}`)),
    (msg) => toast('error', msg),
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.scrollHeight > el.clientHeight || text === '') {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    }
  }, [text]);

  const send = () => {
    if (disabled) return;
    if (dictation.state !== 'idle') dictation.stop();
    const value = text;
    haptic();
    onSend(value);
    if (value.trim()) {
      const i = history.indexOf(value);
      if (i >= 0) history.splice(i, 1);
      history.unshift(value);
      history.length = Math.min(history.length, HISTORY_LIMIT);
    }
    setHistIdx(-1);
    setText('');
  };

  const recall = (dir: 1 | -1) => {
    const next = Math.min(history.length - 1, Math.max(-1, histIdx + dir));
    setHistIdx(next);
    setText(next === -1 ? '' : (history[next] ?? ''));
  };

  return (
    <div className="shrink-0 pt-1.5">
      <DictationHint dictation={dictation} />
      <div className="composer flex items-end gap-1 rounded-[22px] p-1">
        <textarea
          ref={ref}
          value={text}
          rows={1}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            setHistIdx(-1);
          }}
          onKeyDown={(e) => {
            // Hardware keyboard: Enter sends, Shift+Enter = newline, ↑/↓ history.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) {
              e.preventDefault();
              send();
            } else if (e.key === 'ArrowUp' && !text.includes('\n') && history.length) {
              e.preventDefault();
              recall(1);
            } else if (e.key === 'ArrowDown' && histIdx >= 0) {
              e.preventDefault();
              recall(-1);
            }
          }}
          placeholder={placeholder}
          aria-label="Compose terminal input"
          enterKeyHint="enter"
          style={{ fieldSizing: 'content' } as React.CSSProperties}
          className="max-h-[120px] min-h-10 flex-1 resize-none bg-transparent px-3 py-2 text-[15px] leading-snug outline-none placeholder:text-dim/60"
        />
        <MicButton dictation={dictation} size={40} />
        <button
          type="button"
          aria-label={text ? 'Send to terminal' : 'Press Enter'}
          onClick={send}
          disabled={disabled}
          className={clsx(
            'press flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white disabled:opacity-35',
            text ? 'btn-primary' : 'bg-surface-3 text-ink',
          )}
        >
          {text ? <ArrowUp size={19} strokeWidth={2.4} /> : <CornerDownLeft size={17} />}
        </button>
      </div>
    </div>
  );
}

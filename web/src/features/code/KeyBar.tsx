import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ClipboardPaste, CornerDownLeft, Keyboard, Minus, Paperclip, Plus, Type } from 'lucide-react';
import { usePrefs } from '../../store/prefs';
import { haptic } from '../../util/haptics';
import { KEYS, ctrlChar } from './termInput';

interface Props {
  onKey: (seq: string) => void;
  ctrl: boolean;
  alt: boolean;
  onToggleCtrl: () => void;
  onToggleAlt: () => void;
  onPaste: () => void;
  onAttach: () => void;
  disabled?: boolean;
}

/** Keys a phone keyboard can't send: modifiers, arrows, Esc, Tab, ^C … */
export function KeyBar({ onKey, ctrl, alt, onToggleCtrl, onToggleAlt, onPaste, onAttach, disabled }: Props) {
  const compose = usePrefs((s) => s.termCompose);
  const fontSize = usePrefs((s) => s.termFontSize);
  const setPref = usePrefs((s) => s.set);

  const press = (seq: string) => {
    if (disabled) return;
    haptic();
    let out = seq;
    if (ctrl && seq.length === 1) out = ctrlChar(seq) ?? seq;
    if (alt) out = `\u001b${out}`;
    onKey(out);
  };

  const key = (label: React.ReactNode, seq: string, aria: string, extra?: string) => (
    <button key={aria} type="button" aria-label={aria} className={`kbd ${extra ?? ''}`} onClick={() => press(seq)}>
      {label}
    </button>
  );

  return (
    <div className="flex shrink-0 items-center gap-1.5 pt-1.5">
      <button
        type="button"
        aria-label={compose ? 'Type directly into the terminal' : 'Use the compose bar'}
        aria-pressed={!compose}
        className="kbd"
        onClick={() => {
          haptic();
          setPref('termCompose', !compose);
        }}
      >
        {compose ? <Keyboard size={15} /> : <Type size={15} />}
      </button>
      <button type="button" aria-label="Attach an image or file" className="kbd" disabled={disabled} onClick={() => { haptic(); onAttach(); }}>
        <Paperclip size={15} />
      </button>
      <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        <button type="button" className="kbd" aria-pressed={ctrl} onClick={() => { haptic(); onToggleCtrl(); }}>
          Ctrl
        </button>
        {key('Esc', KEYS.esc, 'Escape')}
        {key('Tab', KEYS.tab, 'Tab')}
        {key('⇧Tab', KEYS.shiftTab, 'Shift Tab')}
        {key(<ArrowUp size={15} />, KEYS.up, 'Up')}
        {key(<ArrowDown size={15} />, KEYS.down, 'Down')}
        {key(<ArrowLeft size={15} />, KEYS.left, 'Left')}
        {key(<ArrowRight size={15} />, KEYS.right, 'Right')}
        {key(<CornerDownLeft size={15} />, KEYS.enter, 'Enter')}
        {key('^C', '\u0003', 'Control C', 'text-danger')}
        {key('^D', '\u0004', 'Control D')}
        {key('^R', '\u0012', 'Control R')}
        {key('^L', '\u000c', 'Control L')}
        {key('^Z', '\u001a', 'Control Z')}
        <button type="button" className="kbd" aria-pressed={alt} onClick={() => { haptic(); onToggleAlt(); }}>
          Alt
        </button>
        {key('PgUp', KEYS.pgUp, 'Page up')}
        {key('PgDn', KEYS.pgDn, 'Page down')}
        {key('Home', KEYS.home, 'Home')}
        {key('End', KEYS.end, 'End')}
        {['/', '|', '~', '-', '_', '\\', '`', '*', '&', '$', '>', '<'].map((c) => key(c, c, `Symbol ${c}`))}
        <button type="button" aria-label="Paste" className="kbd" onClick={onPaste}>
          <ClipboardPaste size={15} />
        </button>
        <button type="button" aria-label="Smaller font" className="kbd" onClick={() => setPref('termFontSize', Math.max(8, fontSize - 1))}>
          <Minus size={14} />
        </button>
        <button type="button" aria-label="Larger font" className="kbd" onClick={() => setPref('termFontSize', Math.min(22, fontSize + 1))}>
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
}

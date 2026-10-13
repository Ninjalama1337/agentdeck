import { useRef } from 'react';
import { Camera, ClipboardPaste, FileText, Image as ImageIcon } from 'lucide-react';
import { Sheet } from './ui/Sheet';
import { useAppStore } from '../store/appStore';
import { readClipboard } from '../util/incomingFiles';

interface Props {
  open: boolean;
  onClose: () => void;
  /** `shrink`: photos and pictures, scaled down before upload — files picked as files go up untouched. */
  onFiles: (files: File[], shrink: boolean) => void;
  /** Text found in the clipboard by "Paste from clipboard". */
  onText: (text: string) => void;
  hint: string;
}

/** "Add attachment": camera, gallery, file picker or whatever the clipboard holds. */
export function AttachSheet({ open, onClose, onFiles, onText, hint }: Props) {
  const toast = useAppStore((s) => s.toast);
  const photoInput = useRef<HTMLInputElement | null>(null);
  const imageInput = useRef<HTMLInputElement | null>(null);
  const anyInput = useRef<HTMLInputElement | null>(null);

  const pick = (input: HTMLInputElement | null) => {
    onClose();
    input?.click();
  };
  const picked = (e: React.ChangeEvent<HTMLInputElement>, shrink: boolean) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length) onFiles(files, shrink);
  };
  const paste = async () => {
    onClose();
    try {
      const clip = await readClipboard();
      if (clip.files.length) onFiles(clip.files, true);
      else if (clip.text) onText(clip.text);
      else toast('warn', 'The clipboard is empty');
    } catch {
      toast('warn', 'Clipboard not readable — long-press the input field to paste');
    }
  };

  return (
    <>
      <Sheet open={open} onClose={onClose} title="Add attachment">
        <div className="flex flex-col gap-1.5">
          <AttachRow icon={<ClipboardPaste size={18} />} title="Paste from clipboard" hint="A copied screenshot or image" onClick={() => void paste()} />
          <AttachRow icon={<Camera size={18} />} title="Take photo" hint="Capture with the device camera" onClick={() => pick(photoInput.current)} />
          <AttachRow icon={<ImageIcon size={18} />} title="Choose image" hint="From gallery" onClick={() => pick(imageInput.current)} />
          <AttachRow icon={<FileText size={18} />} title="Choose file" hint="PDF, text, logs, code" onClick={() => pick(anyInput.current)} />
          <p className="px-1 pt-1 text-[12px] text-dim">{hint}</p>
        </div>
      </Sheet>

      {/* hidden inputs (kept mounted) */}
      <input ref={photoInput} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => picked(e, true)} />
      <input ref={imageInput} type="file" accept="image/*" multiple className="hidden" onChange={(e) => picked(e, true)} />
      <input ref={anyInput} type="file" multiple className="hidden" onChange={(e) => picked(e, false)} />
    </>
  );
}

function AttachRow({
  icon,
  title,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="press tap flex w-full items-center gap-3 rounded-2xl border border-line bg-white/[0.04] px-4 py-3 text-left active:bg-white/[0.08]"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/15 text-accent">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium">{title}</span>
        <span className="block text-[12px] text-dim">{hint}</span>
      </span>
    </button>
  );
}

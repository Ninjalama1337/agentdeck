import { useEffect, type ReactNode } from 'react';
import { IconButton } from './Button';
import { X } from 'lucide-react';
import { registerOverlayClose } from '../../util/overlayHistory';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}

export function Modal({ open, onClose, title, children }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // Android back / browser back closes the dialog instead of leaving the page.
    const releaseBack = registerOverlayClose(onClose);
    return () => {
      window.removeEventListener('keydown', onKey);
      releaseBack();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop flex items-center justify-center p-5" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal-card glass safe-b flex max-h-[82dvh] w-full max-w-xl flex-col p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 pb-2">
          <h2 className="text-[16px] font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose} className="h-9 w-9">
            <X size={18} />
          </IconButton>
        </div>
        <div className="overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

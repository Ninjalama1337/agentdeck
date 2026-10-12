import { useEffect, useRef, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { useAppStore } from '../../store/appStore';
import { registerOverlayClose } from '../../util/overlayHistory';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
}

/**
 * Bottom sheet: drag handle, backdrop, touch drag-to-dismiss, a close button
 * that is ALWAYS visible, and system-back integration (Android back gesture
 * closes the topmost sheet instead of exiting).
 *
 * The sheet caps at ~88dvh so the app behind stays visible — it reads as an
 * overlay, and the exposed backdrop strip is a second tap-to-close target.
 * Every open sheet bumps `overlayDepth` so the TabBar slides away (mirrors
 * the keyboard treatment).
 */
export function Sheet({ open, onClose, title, subtitle, children }: SheetProps) {
  const [offset, setOffset] = useState(0);
  const startY = useRef<number | null>(null);
  const dragging = useRef(false);
  const pushOverlay = useAppStore((s) => s.pushOverlay);
  const popOverlay = useAppStore((s) => s.popOverlay);

  useEffect(() => {
    if (!open) {
      setOffset(0);
      return;
    }
    pushOverlay();
    const releaseBack = registerOverlayClose(onClose);
    // Cleanup runs on close AND on unmount-while-open — the counter can never leak.
    return () => {
      popOverlay();
      releaseBack();
    };
  }, [open, onClose, pushOverlay, popOverlay]);

  useEffect(() => {
    if (!open) {
      setOffset(0);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const onTouchStart = (e: React.TouchEvent) => {
    startY.current = e.touches[0].clientY;
    dragging.current = true;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (!dragging.current || startY.current === null) return;
    const dy = e.touches[0].clientY - startY.current;
    if (dy > 0) setOffset(dy);
  };
  const onTouchEnd = () => {
    dragging.current = false;
    startY.current = null;
    if (offset > 110) onClose();
    else setOffset(0);
  };

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx('sheet-panel', offset > 0 && 'transition-none')}
        style={offset > 0 ? { transform: `translateY(${offset}px)` } : undefined}
      >
        <div className="sheet-card mx-auto flex max-h-[88dvh] w-full max-w-xl flex-col px-4">
          <div
            className="sheet-handle flex shrink-0 cursor-grab justify-center py-2.5"
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
          >
            <div className="h-1.5 w-11 rounded-full bg-white/30" />
          </div>
          {/* Header always carries a visible close affordance — the sheet can
              never become a trap. The whole strip also drags to dismiss. */}
          <header
            className="flex shrink-0 items-start gap-3 pb-3"
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
          >
            <div className="min-w-0 flex-1 px-1">
              {title && <h2 className="text-[17px] font-semibold leading-snug text-ink">{title}</h2>}
              {subtitle && <p className="mt-0.5 text-[13px] leading-snug text-dim">{subtitle}</p>}
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="press tap ml-auto flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-white/[0.05] text-dim active:bg-white/[0.12] active:text-ink"
            >
              <X size={17} />
            </button>
          </header>
          {/* flex-1 + overflow: the scroll area always ends at the panel's own
              bottom padding — content can never be clipped behind the edge. */}
          <div className="no-scrollbar flex-1 overflow-y-auto overscroll-contain px-1 pb-[calc(env(safe-area-inset-bottom,0px)+30px)]">
            {children}
          </div>
        </div>
      </div>
    </>
  );
}

import { useState } from 'react';
import { X } from 'lucide-react';
import { useAppStore } from '../store/appStore';

/** Fullscreen image viewer with a simple tap-to-zoom scale toggle. */
export function Lightbox() {
  const lightbox = useAppStore((s) => s.lightbox);
  const setLightbox = useAppStore((s) => s.setLightbox);
  const [zoomed, setZoomed] = useState(false);

  if (!lightbox) return null;

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-black/92 safe-t safe-b" role="dialog" aria-modal="true">
      <div className="flex items-center justify-between p-3">
        <p className="min-w-0 truncate px-2 text-[13px] text-dim">{lightbox.name ?? 'Image'}</p>
        <button
          aria-label="Close image viewer"
          onClick={() => {
            setZoomed(false);
            setLightbox(null);
          }}
          className="tap flex h-11 w-11 items-center justify-center rounded-xl text-ink active:bg-white/10"
        >
          <X size={22} />
        </button>
      </div>
      <div className="flex flex-1 items-center justify-center overflow-hidden p-3" onClick={() => setZoomed((z) => !z)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={lightbox.url}
          alt={lightbox.name ?? 'Shared image'}
          className="max-h-full max-w-full select-none rounded-lg object-contain transition-transform duration-200"
          style={{ transform: zoomed ? 'scale(2.1)' : 'scale(1)', cursor: zoomed ? 'zoom-out' : 'zoom-in' }}
        />
      </div>
      <p className="pb-2 text-center text-xs text-dim">Tap image to toggle zoom</p>
    </div>
  );
}

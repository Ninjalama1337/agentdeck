import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileQuestion, Loader2, RotateCw, TriangleAlert, X } from 'lucide-react';
import { api, ApiError, fetchBlob } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';
import { Button } from '../../components/ui/Button';
import { Sheet } from '../../components/ui/Sheet';
import { bytes } from '../../util/format';

interface FileEditorSheetProps {
  open: boolean;
  projectId: string;
  /** Project-relative path with forward slashes. */
  path: string;
  onClose: () => void;
}

type ExternalBanner = 'none' | 'changed' | 'deleted';

/**
 * In-app text file editor inside a bottom sheet. Loads via
 * GET /files/content, saves via PUT /files/content and listens to the
 * `files:changed` pub/sub in the store: clean buffer → silent reload,
 * dirty buffer → non-blocking banner (never auto-clobbers user edits).
 */
export function FileEditorSheet({ open, projectId, path, onClose }: FileEditorSheetProps) {
  const toast = useAppStore((s) => s.toast);
  const fileEvents = useAppStore((s) => s.fileEvents);

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [binary, setBinary] = useState(false);
  const [text, setText] = useState('');
  const [savedText, setSavedText] = useState('');
  const [size, setSize] = useState<number | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<ExternalBanner>('none');

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  /** Events before this ts are ignored (self-echo of our own save / pre-load state). */
  const suppressUntilRef = useRef(0);
  /** High-water mark of already-processed pub/sub events. */
  const lastEventTsRef = useRef(0);

  const fileName = path.split('/').pop() || path;
  const dirPart = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const dirty = !binary && !truncated && text !== savedText;

  /* ------------------------------------------------------------ loading */

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setBinary(false);
    setBanner('none');
    try {
      const res = await api.getFileContent(projectId, path);
      setText(res.content);
      setSavedText(res.content);
      setSize(res.size);
      setTruncated(res.truncated);
      // Everything the watcher recorded up to now is already on screen.
      suppressUntilRef.current = Date.now();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 415 || err.code === 'NON_TEXT')) {
        setBinary(true);
        toast('info', 'Binary file — preview only');
      } else {
        setLoadError(errorMessage(err));
        toast('error', errorMessage(err));
      }
    } finally {
      setLoading(false);
    }
  }, [projectId, path, toast]);

  useEffect(() => {
    if (!open) return;
    // Swallow every event recorded before/while the initial GET runs — its
    // result already reflects them.
    suppressUntilRef.current = Number.MAX_SAFE_INTEGER;
    lastEventTsRef.current = 0;
    void load();
  }, [open, load]);

  /* ------------------------------------------------------------ saving */

  const save = async () => {
    if (saving || truncated || binary || text === savedText) return;
    setSaving(true);
    try {
      const res = await api.saveFileContent(projectId, path, text);
      setSavedText(text);
      setSize(res.size);
      // Our own write flows back through the watcher (~400 ms debounce) —
      // suppress that echo so the clean buffer is not "reloaded".
      suppressUntilRef.current = Date.now() + 1500;
      toast('info', 'Saved');
    } catch (err) {
      toast('error', `Save failed: ${errorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  /* ------------------------------------------- external change pub/sub */

  useEffect(() => {
    if (!open) return;
    const relevant = fileEvents.filter(
      (e) => e.projectId === projectId && e.path === path && e.ts > lastEventTsRef.current,
    );
    if (relevant.length === 0) return;
    lastEventTsRef.current = relevant[relevant.length - 1].ts;

    let dirtyNow = text !== savedText;
    let deletedNow = false;
    for (const ev of relevant) {
      if (ev.ts < suppressUntilRef.current) continue;
      if (ev.type === 'delete') {
        deletedNow = true;
        continue;
      }
      if (dirtyNow) {
        setBanner('changed'); // never clobber user edits — offer Reload only
      } else {
        dirtyNow = false;
        void load();
        toast('info', 'File changed on disk — reloaded');
        return; // load() re-arms the suppression window
      }
    }
    if (deletedNow) {
      if (dirtyNow) setBanner('deleted');
      else {
        toast('info', 'File deleted on disk');
        onClose();
      }
    }
  }, [fileEvents, open, projectId, path, text, savedText, load, toast, onClose]);

  /* -------------------------------------------------------- auto-grow */

  useEffect(() => {
    const grow = () => {
      const el = taRef.current;
      if (!el) return;
      el.style.height = 'auto';
      const min = Math.round(window.innerHeight * 0.4);
      const max = Math.round(window.innerHeight * 0.6);
      el.style.height = `${Math.min(Math.max(el.scrollHeight, min), max)}px`;
    };
    grow();
    window.addEventListener('resize', grow);
    return () => window.removeEventListener('resize', grow);
  }, [text, loading, binary, truncated, loadError]);

  /* ------------------------------------------------------------- Tab */

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = el.value.slice(0, start) + '  ' + el.value.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + 2;
    });
  };

  /* -------------------------------------------------------- download */

  const downloadBinary = async () => {
    try {
      const blob = await fetchBlob(api.fileRawPath(projectId, path));
      const file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' });
      const canShare = typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
      if (canShare) {
        await navigator.share({ files: [file], title: fileName });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 8000);
      }
    } catch (err) {
      if (err instanceof ApiError) toast('error', errorMessage(err));
      /* user cancelled the share sheet — ignore */
    }
  };

  /* ----------------------------------------------------------- render */

  return (
    <Sheet open={open} onClose={onClose} title={fileName} subtitle={dirPart || 'Project root'}>
      {/* meta row */}
      <div className="mb-2.5 flex min-h-9 flex-wrap items-center gap-2 px-1">
        {dirty && (
          <span
            aria-label="Unsaved changes"
            className="h-2 w-2 shrink-0 rounded-full bg-warn"
            style={{ boxShadow: '0 0 6px rgba(245,158,11,0.8)' }}
          />
        )}
        {size !== null && <span className="text-[12px] text-dim">{bytes(size)}</span>}
        <span className="flex-1" />
        {truncated && (
          <span className="rounded-lg border border-warn/30 bg-warn/10 px-2 py-1 text-[11.5px] font-medium text-warn">
            Read-only preview — file &gt; 1 MB
          </span>
        )}
        {!binary && !loadError && (
          <Button
            variant="primary"
            size="sm"
            loading={saving}
            disabled={!dirty || truncated}
            onClick={() => void save()}
          >
            Save
          </Button>
        )}
      </div>

      {/* external-change banner (non-blocking, never auto-clobbers) */}
      {banner === 'changed' && (
        <div className="mb-2.5 flex items-center gap-2 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2">
          <TriangleAlert size={15} className="shrink-0 text-warn" />
          <span className="flex-1 text-[12.5px] font-medium text-warn">File changed on disk</span>
          <button
            type="button"
            onClick={() => void load()}
            className="tap flex items-center gap-1.5 rounded-lg bg-warn/20 px-2.5 text-[12px] font-semibold text-warn active:bg-warn/30"
          >
            <RotateCw size={13} /> Reload
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setBanner('none')}
            className="tap flex h-8 w-8 items-center justify-center rounded-lg text-warn/80 active:bg-warn/20"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {banner === 'deleted' && (
        <div className="mb-2.5 flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2">
          <TriangleAlert size={15} className="shrink-0 text-danger" />
          <span className="flex-1 text-[12.5px] font-medium text-danger">File deleted on disk</span>
          <button
            type="button"
            onClick={onClose}
            className="tap rounded-lg bg-danger/20 px-2.5 text-[12px] font-semibold text-danger active:bg-danger/30"
          >
            Close editor
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setBanner('none')}
            className="tap flex h-8 w-8 items-center justify-center rounded-lg text-danger/80 active:bg-danger/20"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* body */}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-dim">
          <Loader2 size={16} className="animate-spin" /> Loading file…
        </div>
      ) : binary ? (
        <div className="flex flex-col items-center gap-3 px-2 py-14 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/[0.06] text-dim">
            <FileQuestion size={22} />
          </span>
          <p className="text-[14px] font-semibold">Binary file</p>
          <p className="max-w-[240px] text-[12.5px] text-dim">
            This file can’t be shown as text — download it to view it outside the app.
          </p>
          <Button variant="primary" size="md" icon={<Download size={16} />} onClick={() => void downloadBinary()}>
            Download
          </Button>
        </div>
      ) : loadError ? (
        <div className="flex flex-col items-center gap-3 px-2 py-14 text-center">
          <p className="text-[14px] font-semibold text-danger">Could not load file</p>
          <p className="max-w-[260px] text-[12.5px] text-dim">{loadError}</p>
          <Button variant="glass" size="md" icon={<RotateCw size={15} />} onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : (
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          wrap="soft"
          readOnly={truncated}
          aria-label={`Editing ${fileName}`}
          className="block w-full resize-none overflow-y-auto rounded-2xl border border-line bg-black/35 px-3.5 py-3 font-mono text-[12.5px] leading-relaxed text-ink outline-none transition-colors focus:border-accent/50"
          style={{ minHeight: '40vh' }}
        />
      )}
    </Sheet>
  );
}

/**
 * Design Mode: the dev server's page in a frame, with the picker bridge
 * injected by the preview proxy. Tap an element, review what was captured, and
 * put it into the composer — HTML, selector and the styles that apply.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Frame, Loader2, MousePointerClick, RefreshCw, X } from 'lucide-react';
import { clsx } from 'clsx';
import type { PortInfo } from '@agentdeck/shared';
import { api } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';
import { useChatActions } from '../../store/chatActions';
import { loadComposerDraft } from '../../store/composerDrafts';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { openExternal } from '../../util/openExternal';
import {
  asDesignPick,
  DESIGN_HOST_SOURCE,
  DESIGN_SOURCE,
  pickSummary,
  withDesignPick,
  type DesignPick,
} from './designPick';

export function DesignMode({
  open,
  sessionId,
  onClose,
}: {
  open: boolean;
  sessionId: string;
  onClose: () => void;
}) {
  const toast = useAppStore((s) => s.toast);
  const setPrefill = useChatActions((s) => s.setPrefill);
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [port, setPort] = useState<number>();
  const [link, setLink] = useState<{ url: string; remote: boolean }>();
  const [picking, setPicking] = useState(true);
  const [pick, setPick] = useState<DesignPick>();
  const [nonce, setNonce] = useState(0);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const origin = useMemo(() => {
    try {
      return link ? new URL(link.url).host : '';
    } catch {
      return '';
    }
  }, [link]);

  /** Origin of the signed preview link; only messages from it are accepted. */
  const previewOrigin = useMemo(() => {
    try {
      return link ? new URL(link.url).origin : '';
    } catch {
      return '';
    }
  }, [link]);

  /* Ports of the running dev servers. */
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    api
      .ports()
      .then((list) => {
        if (!live) return;
        setPorts(list);
        setPort((current) => current ?? list[0]?.port);
      })
      .catch(() => live && setPorts([]))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [open]);

  /* Signed, design-mode preview link for the chosen port. */
  useEffect(() => {
    if (!open || port === undefined) return;
    let live = true;
    setPick(undefined);
    api
      .previewLink(port, true)
      .then((res) => live && setLink({ url: res.url, remote: res.remote }))
      .catch((err) => live && toast('error', errorMessage(err)));
    return () => {
      live = false;
    };
  }, [open, port, nonce, toast]);

  /* Toggle the bridge (also re-sent when the frame reloads). */
  const tellBridge = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ source: DESIGN_HOST_SOURCE, type: 'set', on: picking }, '*');
  }, [picking]);

  useEffect(() => {
    if (open) tellBridge();
  }, [open, tellBridge]);

  /* Answers from the bridge inside the preview frame. */
  useEffect(() => {
    if (!open) return;
    const onMessage = (ev: MessageEvent) => {
      // Only the preview frame may talk to us, and only from the preview origin.
      const frame = frameRef.current;
      if (!frame || ev.source !== frame.contentWindow) return;
      if (previewOrigin && ev.origin !== previewOrigin) return;
      const data = ev.data as { source?: string; type?: string; pick?: unknown } | undefined;
      if (!data || data.source !== DESIGN_SOURCE) return;
      if (data.type === 'ready') {
        tellBridge();
        return;
      }
      if (data.type === 'off') {
        setPicking(false);
        return;
      }
      if (data.type === 'pick') {
        const parsed = asDesignPick(data.pick);
        if (parsed) setPick(parsed);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [open, tellBridge, previewOrigin]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const mixedContent = typeof window !== 'undefined' && window.location.protocol === 'https:' && link?.url.startsWith('http:');

  const insert = () => {
    if (!pick) return;
    const existing = loadComposerDraft(sessionId).text;
    setPrefill(sessionId, withDesignPick(existing, pick, origin));
    toast('info', 'Inserted into the message field');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[70] flex flex-col safe-t safe-b" style={{ background: 'var(--ad-bg, #0d0f14)' }} role="dialog" aria-modal="true" aria-label="Design mode">
      <div className="flex items-center gap-1.5 border-b border-line px-2 py-1.5">
        <span className="ml-1 flex items-center gap-1.5 text-[13.5px] font-semibold">
          <Frame size={15} className="text-accent" aria-hidden /> Design mode
        </span>
        <button
          type="button"
          aria-pressed={picking}
          onClick={() => setPicking((v) => !v)}
          className={clsx(
            'press tap ml-2 flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12px] font-semibold',
            picking ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line bg-white/[0.04] text-dim',
          )}
        >
          <MousePointerClick size={13} aria-hidden />
          {picking ? 'Picking' : 'Pick'}
        </button>
        {link && (
          <button
            type="button"
            aria-label="Open the preview in a browser"
            onClick={() => openExternal(link.url)}
            className="press flex h-8 w-8 items-center justify-center rounded-full text-dim active:bg-white/10"
          >
            <ExternalLink size={15} />
          </button>
        )}
        <button
          type="button"
          aria-label="Reload the preview"
          onClick={() => setNonce((n) => n + 1)}
          className="press flex h-8 w-8 items-center justify-center rounded-full text-dim active:bg-white/10"
        >
          <RefreshCw size={15} />
        </button>
        <button
          type="button"
          aria-label="Close design mode"
          onClick={onClose}
          className="press ml-auto flex h-9 w-9 items-center justify-center rounded-xl text-ink active:bg-white/10"
        >
          <X size={20} />
        </button>
      </div>

      {ports.length > 0 && (
        <div className="no-scrollbar flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line px-2 py-1.5">
          {ports.map((p) => (
            <button
              key={`${p.pid}:${p.port}`}
              type="button"
              aria-pressed={p.port === port}
              onClick={() => {
                setPick(undefined);
                setPort(p.port);
              }}
              className={clsx(
                'press shrink-0 rounded-full border px-3 py-1 text-[12px] font-medium',
                p.port === port ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line bg-white/[0.04] text-dim',
              )}
            >
              :{p.port} <span className="opacity-70">{p.process}</span>
            </button>
          ))}
        </div>
      )}

      {link?.remote && (
        <p className="border-b border-line bg-warn/10 px-3 py-1.5 text-[11.5px] leading-snug text-warn">
          You are connected through a tunnel — the preview port is only reachable on the server's own network.
        </p>
      )}
      {mixedContent && (
        <p className="border-b border-line bg-warn/10 px-3 py-1.5 text-[11.5px] leading-snug text-warn">
          This page is HTTPS but the preview is HTTP, so the browser blocks the frame. Open AgentDeck at
          {' '}<span className="font-mono">http://&lt;server&gt;:&lt;port&gt;</span> to use design mode.
        </p>
      )}

      <div className="relative min-h-0 flex-1 bg-white">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40">
            <Loader2 size={22} className="animate-spin text-white" />
          </div>
        )}
        {!loading && ports.length === 0 && (
          <div className="flex h-full items-center justify-center bg-[var(--ad-bg,#0d0f14)]">
            <EmptyState
              icon={Frame}
              title="No dev server found"
              hint="Start one in a terminal (Code tab), then reopen design mode."
            />
          </div>
        )}
        {link && !mixedContent && (
          <iframe
            ref={frameRef}
            key={link.url}
            src={link.url}
            title="Design mode preview"
            onLoad={tellBridge}
            className="h-full w-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        )}
      </div>

      {pick && (
        <div className="border-t border-line p-3" style={{ background: 'var(--ad-glass-strong, #141822)' }}>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold">{pickSummary(pick)}</p>
              <p className="truncate font-mono text-[11.5px] text-dim" title={pick.selector}>
                {pick.selector}
              </p>
              <p className="mt-0.5 text-[11.5px] text-dim/80">
                {pick.html.length} chars HTML · {Object.keys(pick.styles).length} styles
                {pick.text ? ` · “${pick.text.slice(0, 40)}”` : ''}
              </p>
            </div>
            <Button size="sm" variant="primary" onClick={insert} className="shrink-0">
              Insert
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPick(undefined)} className="shrink-0">
              Discard
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

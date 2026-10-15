import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import type { PortInfo } from '@agentdeck/shared';
import { api } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';
import { openExternal } from '../../util/openExternal';

const POLL_MS = 10_000;

/**
 * Dev servers the terminals started (after Orca's ports view): one chip per
 * listening port; a tap opens it through the server's preview proxy — on the
 * phone too. Older servers without /api/ports show nothing.
 */
export function PortChips({ className = '' }: { className?: string }) {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const terminalCount = useAppStore((s) => s.terminals.length);
  const presets = useAppStore((s) => s.terminalPresets);
  const terminals = useAppStore((s) => s.terminals);

  useEffect(() => {
    if (terminalCount === 0) {
      setPorts([]);
      return;
    }
    let live = true;
    let timer: number | undefined;
    let supported = true;
    const load = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const list = await api.ports();
          if (live) setPorts(list);
        } catch {
          supported = false; // older server
        }
      }
      if (live && supported) timer = window.setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [terminalCount]);

  if (ports.length === 0) return null;

  const open = async (p: PortInfo) => {
    const store = useAppStore.getState();
    try {
      const link = await api.previewLink(p.port);
      if (link.remote) store.toast('warn', 'Previews need the same network as the computer — the tunnel only carries AgentDeck itself.');
      openExternal(link.url);
    } catch (err) {
      store.toast('error', errorMessage(err));
    }
  };

  return (
    <div className={`no-scrollbar flex shrink-0 items-center gap-1.5 overflow-x-auto ${className}`} aria-label="Open ports">
      {ports.map((p) => {
        const term = terminals.find((t) => t.id === p.terminalId);
        const accent = presets?.find((x) => x.id === term?.presetId)?.accent ?? '#2DD4BF';
        return (
          <button
            key={`${p.pid}:${p.port}`}
            type="button"
            onClick={() => void open(p)}
            title={`${p.process} (pid ${p.pid}) in ${term?.title ?? 'a terminal'} — open preview`}
            className="press flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-line bg-white/[0.04] px-3 text-[12px] font-medium"
          >
            <Globe size={13} style={{ color: accent }} />
            <span className="tabular-nums">:{p.port}</span>
            <span className="text-dim">{p.process}</span>
          </button>
        );
      })}
    </div>
  );
}

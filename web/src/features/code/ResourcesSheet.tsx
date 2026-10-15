import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Cpu, Loader2, X } from 'lucide-react';
import { clsx } from 'clsx';
import type { ResourcesResponse, TerminalResources } from '@agentdeck/shared';
import { api } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';
import { Sheet } from '../../components/ui/Sheet';
import { bytes } from '../../util/format';

/** Event that opens the resource monitor (quick open, Code tab). */
export const OPEN_RESOURCES = 'agentdeck:resources';

export function openResources(): void {
  window.dispatchEvent(new Event(OPEN_RESOURCES));
}

const POLL_MS = 3000;

/**
 * CPU and memory per terminal (after Orca's resource monitor): which agent,
 * tool or dev server is busy, and a way to end a runaway process.
 */
export function ResourcesSheet() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ResourcesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const terminals = useAppStore((s) => s.terminals);
  const presets = useAppStore((s) => s.terminalPresets);

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_RESOURCES, show);
    return () => window.removeEventListener(OPEN_RESOURCES, show);
  }, []);

  useEffect(() => {
    if (!open) return;
    let live = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const res = await api.resources();
        if (!live) return;
        setData(res);
        setError(null);
      } catch (err) {
        if (live) setError(errorMessage(err));
      }
      if (live) timer = window.setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open]);

  useEffect(() => {
    if (armed === null) return;
    const t = window.setTimeout(() => setArmed(null), 3000);
    return () => window.clearTimeout(t);
  }, [armed]);

  const kill = async (terminalId: string, pid: number) => {
    if (armed !== pid) return setArmed(pid);
    setArmed(null);
    try {
      await api.killProcess(terminalId, pid);
      useAppStore.getState().toast('info', `Sent SIGTERM to ${pid}`);
    } catch (err) {
      useAppStore.getState().toast('error', errorMessage(err));
    }
  };

  const sorted: TerminalResources[] = data ? [...data.terminals].sort((a, b) => b.cpu - a.cpu || b.mem - a.mem) : [];
  const sys = data?.system;
  const memUsed = sys ? sys.memTotal - sys.memFree : 0;

  return (
    <Sheet open={open} onClose={() => setOpen(false)} title="Resources" subtitle="CPU and memory per terminal — updates every 3 s">
      {error && <p className="mb-3 text-[12.5px] text-danger">{error}</p>}
      {!data ? (
        <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-dim">
          <Loader2 size={15} className="animate-spin" /> Measuring…
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {sys && (
            <div className="grid grid-cols-2 gap-2">
              <Meter label="Load" value={`${sys.load.toFixed(2)} / ${sys.cpus} cores`} fraction={sys.load / Math.max(1, sys.cpus)} />
              <Meter label="Memory" value={`${bytes(memUsed)} of ${bytes(sys.memTotal)}`} fraction={memUsed / Math.max(1, sys.memTotal)} />
            </div>
          )}
          {sorted.length === 0 && <p className="py-6 text-center text-[13px] text-dim">No terminals running.</p>}
          {sorted.map((r) => {
            const term = terminals.find((t) => t.id === r.id);
            const accent = presets?.find((p) => p.id === term?.presetId)?.accent ?? '#99A1B3';
            const isOpen = expanded === r.id;
            return (
              <div key={r.id} className="rounded-xl border border-line bg-white/[0.03]">
                <button type="button" onClick={() => setExpanded(isOpen ? null : r.id)} className="press flex w-full items-center gap-2.5 px-3 py-2.5 text-left">
                  {isOpen ? <ChevronDown size={14} className="text-dim" /> : <ChevronRight size={14} className="text-dim" />}
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: accent }} />
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{term?.title ?? r.id}</span>
                  <span className={clsx('w-14 text-right text-[12.5px] tabular-nums', r.cpu >= 80 ? 'font-semibold text-danger' : 'text-ink')}>{r.cpu}%</span>
                  <span className="w-16 text-right text-[12px] tabular-nums text-dim">{bytes(r.mem)}</span>
                </button>
                {isOpen && (
                  <ul className="border-t border-line px-3 py-1.5">
                    {r.processes.map((p, i) => (
                      <li key={p.pid} className="flex items-center gap-2 py-1 text-[12px]">
                        <span className="w-14 shrink-0 font-mono text-[11px] text-dim">{p.pid}</span>
                        <span className="min-w-0 flex-1 truncate font-mono">{p.name}{i === 0 ? ' (shell)' : ''}</span>
                        <span className="w-10 text-right tabular-nums">{p.cpu}%</span>
                        <span className="w-14 text-right tabular-nums text-dim">{bytes(p.mem)}</span>
                        {i === 0 ? (
                          <span className="w-16" />
                        ) : (
                          <button
                            type="button"
                            onClick={() => void kill(r.id, p.pid)}
                            className={clsx(
                              'press flex h-7 w-16 items-center justify-center gap-1 rounded-lg text-[11px] font-semibold',
                              armed === p.pid ? 'bg-danger text-white' : 'border border-danger/30 text-danger',
                            )}
                          >
                            <X size={11} /> {armed === p.pid ? 'Sure?' : 'End'}
                          </button>
                        )}
                      </li>
                    ))}
                    {r.count > r.processes.length && <li className="py-1 text-[11px] text-dim">+{r.count - r.processes.length} more, idle</li>}
                  </ul>
                )}
              </div>
            );
          })}
          <p className="flex items-start gap-1.5 px-1 text-[11.5px] leading-relaxed text-dim">
            <Cpu size={13} className="mt-0.5 shrink-0" />
            100% is one full core. “End” sends SIGTERM to that process only — the terminal keeps running.
          </p>
        </div>
      )}
    </Sheet>
  );
}

function Meter({ label, value, fraction }: { label: string; value: string; fraction: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  return (
    <div className="rounded-xl border border-line bg-white/[0.03] px-3 py-2">
      <div className="flex items-baseline justify-between gap-2 text-[11.5px]">
        <span className="font-medium text-dim">{label}</span>
        <span className="truncate tabular-nums">{value}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
        <div className={clsx('h-full rounded-full', pct >= 85 ? 'bg-danger' : 'bg-accent')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

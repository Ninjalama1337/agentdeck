import { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, Loader2, UserRound } from 'lucide-react';
import type { TerminalInfo } from '@agentdeck/shared';
import { api } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';
import { usePrefs } from '../../store/prefs';
import { Sheet } from '../../components/ui/Sheet';
import { tightestWindow } from '../../util/usageWindows';
import { estimateSize } from './termInput';
import { PresetGlyph } from './Launcher';

/**
 * Limit hand-over: the agent in `term` ran out of usage — another agent, or
 * the same one on another account, continues the task in the same folder.
 */
export function HandoverSheet({ term, open, onClose }: { term: TerminalInfo; open: boolean; onClose: () => void }) {
  const presets = useAppStore((s) => s.terminalPresets);
  const accounts = useAppStore((s) => s.accounts);
  const usage = useAppStore((s) => s.usage);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (open && !useAppStore.getState().accountsLoaded) void useAppStore.getState().refreshAccounts().catch(() => undefined);
  }, [open]);

  const options = useMemo(() => {
    const list: { key: string; presetId: string; accountId?: string; label: string; detail?: string; full: boolean }[] = [];
    for (const p of presets ?? []) {
      if (p.kind !== 'agent' || !p.available || !p.promptArg) continue;
      const tight = tightestWindow(usage?.find((u) => u.agentId === p.id));
      const full = tight !== null && tight.pct >= 100;
      if (p.id !== term.presetId) {
        list.push({ key: p.id, presetId: p.id, label: p.label, ...(tight ? { detail: `${tight.pct}% of ${tight.short} used` } : {}), full });
      }
      // The same agent on another login has its own limits.
      for (const a of accounts.filter((acc) => acc.agentId === p.id)) {
        list.push({ key: `${p.id}:${a.id}`, presetId: p.id, accountId: a.id, label: `${p.label} · ${a.name}`, detail: 'other account', full: false });
      }
    }
    // Agents with room first.
    return list.sort((a, b) => Number(a.full) - Number(b.full));
  }, [presets, accounts, usage, term.presetId]);

  const go = async (o: (typeof options)[number]) => {
    setBusy(o.key);
    const store = useAppStore.getState();
    try {
      const { cols, rows } = estimateSize(usePrefs.getState().termFontSize);
      const { terminal } = await api.handover(term.id, {
        presetId: o.presetId,
        ...(o.accountId ? { accountId: o.accountId } : {}),
        cols,
        rows,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      await store.refreshTerminals();
      onClose();
      store.toast('info', `${o.label} takes over`);
      store.openTarget(`terminal:${terminal.id}`);
    } catch (err) {
      store.toast('error', errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Hand over the task" subtitle={`${term.title ?? 'This agent'} — continue with another agent or account`}>
      <p className="mb-3 text-[12.5px] leading-relaxed text-dim">
        The new agent starts in the same folder with the task and the end of this terminal, checks what is already done, and continues. This terminal stays open.
      </p>
      {options.length === 0 && <p className="text-[13px] text-dim">No other agent on the server can take a task on start (Claude Code, Codex, OpenCode, Gemini CLI), and no other account is set up.</p>}
      <div className="flex flex-col gap-1.5">
        {options.map((o) => {
          const preset = presets?.find((p) => p.id === o.presetId);
          return (
            <button
              key={o.key}
              type="button"
              disabled={busy !== null}
              onClick={() => void go(o)}
              className="press tap flex items-center gap-2.5 rounded-xl border border-line bg-white/[0.04] px-3 py-2.5 text-left disabled:opacity-60"
            >
              {preset && <PresetGlyph preset={preset} size={28} />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium">{o.label}</span>
                {o.detail && (
                  <span className={`flex items-center gap-1 text-[11.5px] ${o.full ? 'text-danger' : 'text-dim'}`}>
                    {o.accountId && <UserRound size={10} />}
                    {o.full ? 'limit reached too' : o.detail}
                  </span>
                )}
              </span>
              {busy === o.key ? <Loader2 size={15} className="animate-spin text-dim" /> : <ArrowRightLeft size={15} className="text-dim" />}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

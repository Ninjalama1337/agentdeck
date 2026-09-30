import { useEffect, useState } from 'react';
import { Loader2, Plus, Terminal } from 'lucide-react';
import type { AgentId } from '@agentdeck/shared';
import { useAppStore } from '../../store/appStore';
import { Sheet } from '../../components/ui/Sheet';

/**
 * Add an account profile (BridgeMind multi-account): a named env override set
 * for one agent. Example: CLAUDE_CONFIG_DIR=~/.config/claude-work — log in
 * inside a Code-shell with that env, then pick the account per thread.
 */

/** Env presets per agent — the common second-login mechanisms. */
const PRESETS: Record<string, { key: string; hint: string }> = {
  claude: { key: 'CLAUDE_CONFIG_DIR', hint: 'e.g. ~/.config/claude-work' },
  codex: { key: 'CODEX_HOME', hint: 'e.g. ~/.codex-work' },
  zcode: { key: 'ZCODE_HOME', hint: 'e.g. ~/.zcode-work' },
};

export function AccountSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const agents = useAppStore((s) => s.agents);
  const createAccount = useAppStore((s) => s.createAccount);
  const toast = useAppStore((s) => s.toast);

  const headless = (Object.keys(agents) as AgentId[]).filter((id) => agents[id]?.capabilities.headless);
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState<AgentId>('claude');
  const [envKey, setEnvKey] = useState('CLAUDE_CONFIG_DIR');
  const [envValue, setEnvValue] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setEnvValue('');
    setBusy(false);
    const first = headless[0];
    if (first) {
      setAgentId(first);
      setEnvKey(PRESETS[first]?.key ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pickAgent = (id: AgentId) => {
    setAgentId(id);
    setEnvKey(PRESETS[id]?.key ?? '');
  };

  const valid =
    name.trim().length > 0 &&
    /^[A-Z_][A-Z0-9_]*$/.test(envKey.trim()) &&
    envValue.trim().length > 0 &&
    envValue.trim().length <= 500;

  const save = async () => {
    setBusy(true);
    try {
      await createAccount({
        name: name.trim(),
        agentId,
        env: { [envKey.trim()]: envValue.trim() },
      });
      toast('info', `Account "${name.trim()}" added — pick it when starting a thread.`);
      onClose();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Failed to add account');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Add account" subtitle="A second login for one agent">
      <div className="flex flex-col gap-3.5 pb-2">
        <div>
          <label className="mb-1 block px-1 text-[12px] font-medium text-dim">Name</label>
          <input
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Work account"
            maxLength={60}
          />
        </div>

        <div>
          <label className="mb-1.5 block px-1 text-[12px] font-medium text-dim">Agent</label>
          <div className="no-scrollbar flex gap-1.5 overflow-x-auto pb-1">
            {(headless.length ? headless : (['claude', 'zcode', 'codex'] as AgentId[])).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => pickAgent(id)}
                className={
                  'press tap h-9 shrink-0 rounded-full border px-3.5 text-[13px] font-medium ' +
                  (agentId === id ? 'border-accent/45 bg-accent/15 text-ink' : 'border-line bg-surface-2 text-dim')
                }
              >
                {agents[id]?.label ?? id}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-2.5">
          <div>
            <label className="mb-1 block px-1 text-[12px] font-medium text-dim">Env var</label>
            <input
              className="field font-mono text-[13px]"
              value={envKey}
              onChange={(e) => setEnvKey(e.target.value.toUpperCase())}
              placeholder="CLAUDE_CONFIG_DIR"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div>
            <label className="mb-1 block px-1 text-[12px] font-medium text-dim">Value</label>
            <input
              className="field font-mono text-[13px]"
              value={envValue}
              onChange={(e) => setEnvValue(e.target.value)}
              placeholder={PRESETS[agentId]?.hint ?? '/home/you/.second-login'}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>

        <p className="flex items-start gap-2 rounded-xl border border-line bg-bg-raise p-3 text-[12px] leading-relaxed text-dim">
          <Terminal size={14} className="mt-0.5 shrink-0" />
          Log in from the <span className="font-semibold text-ink">Code</span> tab:{' '}
          <span className="font-mono">
            {envKey.trim()}={envValue.trim() || '<value>'}
          </span>{' '}
          <span className="font-mono">claude</span> (or the agent's login command). No passwords are stored here.
        </p>

        <button
          type="button"
          disabled={!valid || busy}
          onClick={() => void save()}
          className="press tap flex items-center justify-center gap-2 rounded-2xl py-2.5 text-[14px] font-semibold text-white disabled:opacity-45 btn-primary"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
          Add account
        </button>
      </div>
    </Sheet>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Bot, Loader2, ShieldAlert } from 'lucide-react';
import { clsx } from 'clsx';
import type { AgentId, PermissionMode } from '@agentdeck/shared';
import { PERMISSION_MODES, errorMessage, useAppStore } from '../../store/appStore';
import { Sheet } from '../../components/ui/Sheet';
import { AgentAvatar } from '../../components/ui/Avatar';
import { Chip } from '../../components/ui/Chip';

/** Create a session: pick agent, model and permission mode. */
export function NewSessionSheet({
  open,
  onClose,
  projectId,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
}) {
  const agents = useAppStore((s) => s.agents);
  const agentOrder = useAppStore((s) => s.agentOrder);
  const modelPrefs = useAppStore((s) => s.modelPrefs);
  const accounts = useAppStore((s) => s.accounts);
  const refreshAccounts = useAppStore((s) => s.refreshAccounts);
  const createSession = useAppStore((s) => s.createSession);
  const openSession = useAppStore((s) => s.openSession);
  const toast = useAppStore((s) => s.toast);

  const available = agentOrder
    .map((id) => agents[id])
    .filter((a): a is NonNullable<typeof a> => a !== undefined && a.available);
  const [agentId, setAgentId] = useState<AgentId | undefined>(available[0]?.id);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [effort, setEffort] = useState<string>('default');
  const [perm, setPerm] = useState<PermissionMode>('acceptEdits');
  const [accountId, setAccountId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agent = agentId ? agents[agentId] : undefined;
  const agentAccounts = accounts.filter((a) => a.agentId === agentId);
  const agentDefault = agent ? modelPrefs[agent.id] : undefined;

  // Keep the saved default visible even when it comes from OpenCode's live
  // catalog (it is not part of the agent's static preset list).
  const modelChoices = useMemo(() => {
    if (!agent) return [];
    const choices = agent.models.filter((m) => m.id !== 'custom');
    if (
      agentDefault &&
      agentDefault !== 'custom' &&
      !choices.some((m) => m.id === agentDefault)
    ) {
      choices.push({ id: agentDefault, label: agentDefault });
    }
    return choices;
  }, [agent, agentDefault]);

  useEffect(() => {
    if (!open) return;
    void refreshAccounts().catch(() => undefined);
    setError(null);
    setBusy(false);
    setAccountId(undefined);
    if (!agentId && available.length) setAgentId(available[0]?.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!agent) return;
    // persisted preference wins, else first preset
    const pref = modelPrefs[agent.id];
    setModel(pref && pref !== 'custom' ? pref : agent.models[0]?.id);
    setEffort('default');
    setAccountId(undefined);
  }, [agent, modelPrefs]);

  const create = async () => {
    if (!agentId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await createSession({
        projectId,
        agentId,
        model,
        thinkingEffort: effort !== 'default' ? effort : undefined,
        permissionMode: perm,
        ...(accountId ? { accountId } : {}),
      });
      await openSession(session.id);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="New session" subtitle="Pick an agent to drive">
      {available.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-dim">
          No agents are available on the server right now.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {/* agent picker */}
          <div className="flex flex-col gap-1.5">
            {available.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setAgentId(a.id)}
                className={clsx(
                  'press tap flex w-full items-center gap-3 rounded-2xl border px-3.5 py-2.5 text-left',
                  agentId === a.id ? 'border-accent/45 bg-accent/12' : 'border-line bg-white/[0.04]',
                )}
              >
                <AgentAvatar agent={a} agentId={a.id} size="md" glow={agentId === a.id} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] font-semibold">{a.label}</span>
                  <span className="block truncate text-[12px] text-dim">
                    {a.capabilities.headless ? 'Remote chat control' : 'IDE mode on the server'}
                  </span>
                </span>
                {!a.capabilities.headless && <Chip tone="warn">IDE</Chip>}
              </button>
            ))}
          </div>

          {/* model */}
          {agent && modelChoices.length > 0 && (
            <div>
              <p className="mb-1.5 text-[12px] font-medium uppercase tracking-wider text-dim">Model</p>
              <div className="no-scrollbar flex gap-1.5 overflow-x-auto pb-1">
                {modelChoices.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setModel(m.id)}
                    className={clsx(
                      'press tap shrink-0 rounded-full border px-3.5 text-[13px] font-medium',
                      model === m.id ? 'border-accent/45 bg-accent/15 text-ink' : 'border-line bg-white/[0.04] text-dim',
                    )}
                  >
                    {m.id === 'inherit' && agent.defaultModel
                      ? `Default · ${agent.defaultModel.label}`
                      : m.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 px-1 text-[11.5px] text-dim">
                More models are one tap away in the chat bar after the session starts.
              </p>
            </div>
          )}

          {/* thinking effort */}
          {agent && (agent.efforts?.length ?? 0) > 0 && (
            <div>
              <p className="mb-1.5 text-[12px] font-medium uppercase tracking-wider text-dim">Thinking effort</p>
              <div className="no-scrollbar flex gap-1.5 overflow-x-auto pb-1">
                {agent.efforts!.map((level) => (
                  <button
                    key={level}
                    type="button"
                    onClick={() => setEffort(level)}
                    className={clsx(
                      'press tap h-9 shrink-0 rounded-full border px-3.5 text-[13px] font-medium capitalize',
                      effort === level ? 'border-accent/45 bg-accent/15 text-ink' : 'border-line bg-white/[0.04] text-dim',
                    )}
                  >
                    {level === 'default' ? 'Auto' : level}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* account (multi-account switching) */}
          {agentAccounts.length > 0 && (
            <div>
              <p className="mb-1.5 text-[12px] font-medium uppercase tracking-wider text-dim">Account</p>
              <div className="no-scrollbar flex gap-1.5 overflow-x-auto pb-1">
                <button
                  type="button"
                  onClick={() => setAccountId(undefined)}
                  className={clsx(
                    'press tap h-9 shrink-0 rounded-full border px-3.5 text-[13px] font-medium',
                    accountId === undefined ? 'border-accent/45 bg-accent/15 text-ink' : 'border-line bg-white/[0.04] text-dim',
                  )}
                >
                  Default
                </button>
                {agentAccounts.map((acc) => (
                  <button
                    key={acc.id}
                    type="button"
                    onClick={() => setAccountId(acc.id)}
                    className={clsx(
                      'press tap h-9 shrink-0 rounded-full border px-3.5 text-[13px] font-medium',
                      accountId === acc.id ? 'border-accent/45 bg-accent/15 text-ink' : 'border-line bg-white/[0.04] text-dim',
                    )}
                  >
                    {acc.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* permission mode */}
          <div>
            <p className="mb-1.5 text-[12px] font-medium uppercase tracking-wider text-dim">Permissions</p>
            <div className="grid grid-cols-2 gap-1.5">
              {PERMISSION_MODES.map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  onClick={() => setPerm(mode.value)}
                  className={clsx(
                    'press tap flex flex-col rounded-2xl border px-3.5 py-2.5 text-left',
                    perm === mode.value
                      ? mode.danger
                        ? 'border-danger/50 bg-danger/12'
                        : 'border-accent/45 bg-accent/12'
                      : 'border-line bg-white/[0.04]',
                  )}
                >
                  <span className="text-[13.5px] font-semibold">{mode.label}</span>
                  <span className="text-[11px] leading-snug text-dim">{mode.hint}</span>
                </button>
              ))}
            </div>
            {perm === 'bypass' && (
              <p className="mt-2 flex items-start gap-1.5 text-[12px] leading-relaxed text-warn" role="alert">
                <ShieldAlert size={14} className="mt-0.5 shrink-0" />
                The agent runs without asking for permission. Only use this in trusted projects.
              </p>
            )}
          </div>

          {error && (
            <p className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-[13px] text-danger" role="alert">
              {error}
            </p>
          )}

          <button
            type="button"
            disabled={!agentId || busy}
            onClick={() => void create()}
            className="press tap flex items-center justify-center gap-2 rounded-2xl text-[15px] font-semibold text-white disabled:opacity-40 btn-primary"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Bot size={16} />}
            Start session
          </button>
        </div>
      )}
    </Sheet>
  );
}

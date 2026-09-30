import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { clsx } from 'clsx';
import { AGENT_LABELS } from '@agentdeck/shared';
import type { AgentId } from '@agentdeck/shared';
import { useAppStore } from '../../store/appStore';
import { AgentAvatar } from '../../components/ui/Avatar';
import { Chip } from '../../components/ui/Chip';
import { Sheet } from '../../components/ui/Sheet';

const CAPABILITIES: { key: keyof AgentCapFlags; label: string }[] = [
  { key: 'headless', label: 'Headless chat' },
  { key: 'images', label: 'Images' },
  { key: 'resume', label: 'Resume' },
  { key: 'streaming', label: 'Live stream' },
  { key: 'ideLaunch', label: 'IDE launch' },
];

type AgentCapFlags = {
  headless: boolean;
  images: boolean;
  resume: boolean;
  streaming: boolean;
  ideLaunch: boolean;
};

/** Agent detail sheet: availability, version, capabilities, models. */
export function AgentSheet({ agentId, open, onClose }: { agentId: AgentId | null; open: boolean; onClose: () => void }) {
  const agent = useAppStore((s) => (agentId ? s.agents[agentId] : undefined));

  return (
    <Sheet open={open} onClose={onClose} title={agentId ? (agent?.label ?? AGENT_LABELS[agentId]) : undefined} subtitle={agent?.version ? `v${agent.version}` : undefined}>
      {agent ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <AgentAvatar agent={agent} agentId={agent.id} size="lg" showDot />
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold">
                {agent.available ? 'Available' : 'Unavailable'}
              </p>
              <p className="truncate text-[13px] text-dim">
                {agent.available ? (agent.command ?? agent.kind) : (agent.reason ?? 'Not installed on this machine')}
              </p>
            </div>
          </div>

          <div>
            <p className="mb-2 text-[12px] font-medium uppercase tracking-wider text-dim">Capabilities</p>
            <div className="grid grid-cols-2 gap-2">
              {CAPABILITIES.map(({ key, label }) => {
                const on = agent.capabilities[key];
                return (
                  <div
                    key={key}
                    className={clsx(
                      'flex items-center gap-2 rounded-xl border px-3 py-2.5 text-[13px]',
                      on ? 'border-ok/25 bg-ok/8 text-ink' : 'border-line bg-white/[0.03] text-dim',
                    )}
                  >
                    {on ? <Check size={14} className="text-ok" /> : <X size={14} className="text-dim/60" />}
                    {label}
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <p className="mb-2 text-[12px] font-medium uppercase tracking-wider text-dim">
              Models ({agent.models.length})
            </p>
            {agent.models.length ? (
              <div className="flex flex-col gap-1.5">
                {agent.models.map((m) => (
                  <div key={m.id} className="glass-soft flex items-center justify-between gap-2 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-[13.5px] font-medium">{m.label}</p>
                      <p className="truncate font-mono text-[11.5px] text-dim">{m.id}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-dim">No presets — the adapter picks its default.</p>
            )}
          </div>

          {!agent.capabilities.headless && agent.available && (
            <Chip tone="warn">IDE mode — drive this agent from its editor on the server</Chip>
          )}
        </div>
      ) : (
        <p className="py-6 text-center text-[13px] text-dim">Agent not loaded yet.</p>
      )}
    </Sheet>
  );
}

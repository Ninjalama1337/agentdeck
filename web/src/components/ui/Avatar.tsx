import { Bot, Braces, Rocket, Sparkles, Terminal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { clsx } from 'clsx';
import { AGENT_ACCENTS } from '@agentdeck/shared';
import type { AgentId, AgentInfo } from '@agentdeck/shared';

const ICONS: Record<AgentId, LucideIcon> = {
  claude: Sparkles,
  zcode: Terminal,
  antigravity: Rocket,
  codex: Braces,
};

const SIZES = {
  xs: { box: 'h-6 w-6 rounded-lg', icon: 13 },
  sm: { box: 'h-8 w-8 rounded-xl', icon: 16 },
  md: { box: 'h-10 w-10 rounded-2xl', icon: 19 },
  lg: { box: 'h-13 w-13 rounded-[18px]', icon: 24 },
} as const;

interface AgentAvatarProps {
  agent: AgentInfo | undefined;
  agentId: AgentId;
  size?: keyof typeof SIZES;
  glow?: boolean;
  showDot?: boolean;
  className?: string;
}

export function AgentAvatar({ agent, agentId, size = 'md', glow = true, showDot, className }: AgentAvatarProps) {
  const Icon = ICONS[agentId] ?? Bot;
  const accent = agent?.accentColor || AGENT_ACCENTS[agentId];
  const available = agent ? agent.available : true;
  const s = SIZES[size];

  return (
    <span className={clsx('relative inline-flex shrink-0', className)}>
      <span
        aria-hidden
        className={clsx('flex items-center justify-center', s.box)}
        style={{
          background: available ? `${accent}20` : 'rgba(255,255,255,0.05)',
          color: available ? accent : '#5b6478',
          boxShadow: available && glow ? `0 0 18px ${accent}3d, inset 0 0 0 1px ${accent}33` : 'inset 0 0 0 1px rgba(255,255,255,0.07)',
        }}
      >
        <Icon size={s.icon} />
      </span>
      {showDot ? (
        <span
          aria-hidden
          className={clsx(
            'absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-bg',
            available ? 'bg-ok pulse-dot' : 'bg-warn',
          )}
        />
      ) : null}
    </span>
  );
}

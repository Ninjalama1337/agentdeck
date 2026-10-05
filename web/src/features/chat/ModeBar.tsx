import { clsx } from 'clsx';
import type { AgentInfo, Session } from '@agentdeck/shared';
import { PERMISSION_MODES, useAppStore } from '../../store/appStore';
import { haptic } from '../../util/haptics';

/**
 * Permission-mode switcher above the composer (plan / accept edits / default /
 * bypass). Chat turns are separate CLI runs, so the choice is stored on the
 * session and passed as `--permission-mode` from the next message on.
 */
export function ModeBar({ session, agent }: { session: Session; agent: AgentInfo | undefined }) {
  const setMode = useAppStore((s) => s.setSessionPermissionMode);
  if (session.agentId !== 'claude') return null;

  const accent = agent?.accentColor ?? '#7C5CFF';
  const current = PERMISSION_MODES.find((m) => m.value === session.permissionMode);

  const pick = (value: (typeof PERMISSION_MODES)[number]['value'], danger?: boolean) => {
    if (value === session.permissionMode) return;
    if (danger && !window.confirm('Bypass mode runs every action without asking. Continue?')) return;
    haptic('light');
    void setMode(session.id, value);
  };

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto px-3 pb-1 pt-1.5" role="radiogroup" aria-label="Permission mode">
      {PERMISSION_MODES.map((m) => {
        const active = m.value === session.permissionMode;
        const color = m.danger ? '#FF5D6C' : accent;
        return (
          <button
            key={m.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={m.hint}
            onClick={() => pick(m.value, m.danger)}
            className={clsx(
              'press shrink-0 rounded-full border px-3 py-[5px] text-[11.5px] font-semibold',
              !active && 'border-line bg-white/[0.04] text-dim',
            )}
            style={active ? { color, borderColor: `${color}55`, background: `${color}1f` } : undefined}
          >
            {m.label}
          </button>
        );
      })}
      {current && <span className="sr-only">{current.hint}. Applies from your next message.</span>}
    </div>
  );
}

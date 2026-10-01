import type { AgentId, Session, TerminalInfo } from '@agentdeck/shared';
import { AGENT_LABELS } from '@agentdeck/shared';
import { selectSession, type Route } from '../store/appStore';

/** CLI binaries whose name differs from the agent id, for hand-typed terminal commands. */
const COMMAND_AGENTS: Record<string, AgentId> = { agy: 'antigravity' };

function asAgentId(value: string | undefined): AgentId | undefined {
  return value !== undefined && Object.hasOwn(AGENT_LABELS, value) ? (value as AgentId) : undefined;
}

/** Agent CLI running in a terminal: its launcher preset, else the binary of a custom command. */
export function terminalAgent(terminal: TerminalInfo | undefined): AgentId | undefined {
  if (!terminal) return undefined;
  const preset = asAgentId(terminal.presetId);
  if (preset) return preset;
  const bin = terminal.command?.trim().split(/\s+/)[0]?.split('/').pop();
  return bin ? (COMMAND_AGENTS[bin] ?? asAgentId(bin)) : undefined;
}

/**
 * The agent the user is working with right now: the open chat's agent on the
 * Chat tab, the visible terminal's CLI on the Code tab. Undefined elsewhere
 * (and for plain shells) — callers keep showing the last one.
 */
export function agentInUse(st: {
  route: Route;
  activeSessionId: string | null;
  sessionsByProject: Record<string, Session[]>;
  terminals: TerminalInfo[];
  activeTerminalId: string | null;
}): AgentId | undefined {
  if (st.route.name === 'chat') return selectSession(st, st.activeSessionId)?.agentId;
  if (st.route.name === 'code') return terminalAgent(st.terminals.find((t) => t.id === st.activeTerminalId));
  return undefined;
}

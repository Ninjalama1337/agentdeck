/**
 * Agent metadata types — shared between server and web app.
 */
import type { AdminCapability } from './api.js';

/** The one canonical list of agents — server schemas and clients derive from it. */
export const AGENT_IDS = ['claude', 'zcode', 'antigravity', 'codex', 'opencode', 'custom'] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export type AgentKind = 'cli' | 'ide';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass';

export interface AgentCapabilities {
  /** Agent can be driven fully non-interactively (remote chat control). */
  headless: boolean;
  /** Agent accepts image attachments inside prompts. */
  images: boolean;
  /** Agent can resume a previous conversation (session continuity). */
  resume: boolean;
  /** Agent streams live progress events while running. */
  streaming: boolean;
  /** Backend can open / focus the project inside the agent's IDE. */
  ideLaunch: boolean;
}

export interface ModelPreset {
  /** CLI value passed via --model (or adapter equivalent). */
  id: string;
  label: string;
  description?: string;
  /** Provider/group the model belongs to (OpenCode lists several providers). */
  provider?: string;
}

/** What an agent's model picker can show; `defaultModel` is what a run uses without an explicit pick. */
export interface ModelCatalog {
  models: ModelPreset[];
  defaultModel?: ModelPreset;
}

export interface AgentInfo {
  id: AgentId;
  label: string;
  kind: AgentKind;
  /** Brand accent color (hex) used across the UI. */
  accentColor: string;
  /** Whether the agent is installed & drivable on this machine. */
  available: boolean;
  /** Why the agent is unavailable (missing binary, no headless mode, ...). */
  reason?: string;
  version?: string;
  capabilities: AgentCapabilities;
  models: ModelPreset[];
  /** Model a run uses when the session does not pick one, when the agent can report it. */
  defaultModel?: ModelPreset;
  /** Supported thinking/reasoning effort levels ('default' always allowed). */
  efforts?: string[];
  /** Resolved command the adapter would execute. */
  command?: string;
  /** Update/install/login actions the server can run for this agent. */
  admin?: AdminCapability[];
}

export const AGENT_ACCENTS: Record<AgentId, string> = {
  claude: '#FF6A3D',
  zcode: '#7C5CFF',
  antigravity: '#4E8CFF',
  codex: '#10B981',
  opencode: '#F59E0B',
  custom: '#8B5CF6',
};

export const AGENT_LABELS: Record<AgentId, string> = {
  claude: 'Claude Code',
  zcode: 'ZCode',
  antigravity: 'Antigravity (AGY)',
  codex: 'Codex',
  opencode: 'OpenCode',
  custom: 'Custom CLI',
};

export const AGENT_SHORT_LABELS: Record<AgentId, string> = {
  claude: 'Claude',
  zcode: 'ZCode',
  antigravity: 'AGY',
  codex: 'Codex',
  opencode: 'OpenCode',
  custom: 'Custom',
};

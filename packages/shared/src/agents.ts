/**
 * Agent metadata types — shared between server and web app.
 */
import type { AdminCapability } from './api.js';

export type AgentId = 'claude' | 'zcode' | 'antigravity' | 'codex';

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
};

export const AGENT_LABELS: Record<AgentId, string> = {
  claude: 'Claude Code',
  zcode: 'ZCode',
  antigravity: 'Antigravity',
  codex: 'Codex',
};

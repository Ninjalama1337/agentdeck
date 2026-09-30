import type { AgentId, ModelPreset } from '@agentdeck/shared';

/**
 * Curated model presets per agent. `inherit` means "pass no --model flag";
 * `custom` is a UI hint meaning "free-form model id" (also treated as inherit
 * by adapters).
 */
export const MODEL_PRESETS: Record<AgentId, ModelPreset[]> = {
  claude: [
    { id: 'inherit', label: 'Default', description: "Use Claude Code's default model" },
    { id: 'opus', label: 'Opus', description: 'Latest Opus — deepest reasoning' },
    { id: 'sonnet', label: 'Sonnet', description: 'Latest Sonnet — balanced default' },
    { id: 'haiku', label: 'Haiku', description: 'Latest Haiku — fastest' },
  ],
  zcode: [
    { id: 'inherit', label: 'Default', description: "Use ZCode's configured model" },
    { id: 'GLM-5.3', label: 'GLM-5.3', description: 'Most capable GLM — deep reasoning' },
    { id: 'GLM-5.3-Flash', label: 'GLM-5.3-Flash', description: 'Fast GLM for quick tasks' },
    { id: 'GLM-5.2', label: 'GLM-5.2', description: 'Previous GLM generation' },
    { id: 'GLM-5-Turbo', label: 'GLM-5-Turbo', description: 'High-throughput GLM' },
    {
      id: 'custom',
      label: 'Custom…',
      description: 'Enter any model id supported by the agent',
    },
  ],
  antigravity: [
    { id: 'inherit', label: 'Default', description: "Use Antigravity's configured model" },
    {
      id: 'custom',
      label: 'Custom…',
      description: 'Enter any model id supported by the agent',
    },
  ],
  codex: [
    { id: 'inherit', label: 'Default', description: "Use Codex's default model" },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', description: 'Codex-tuned flagship' },
    { id: 'gpt-5.3', label: 'GPT-5.3', description: 'General-purpose flagship' },
  ],
};

/**
 * Registry of agent adapters + AgentService: detection (parallel, 5s capped,
 * never spawns a GUI) and AgentInfo assembly.
 */
import { AGENT_ACCENTS, AGENT_LABELS, type AgentId, type AgentInfo, type ModelCatalog } from '@agentdeck/shared';
import type { Config, ResolvedAgentConfig } from '../config.js';
import type { Logger } from '../logging.js';
import { withTimeoutFallback } from '../util/async.js';
import { AGENT_IDS } from '../config.js';
import { MODEL_PRESETS } from './models.js';
import { adminCapabilities } from '../admin/recipes.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { ZCodeAdapter } from './zcode.js';
import { AntigravityAdapter } from './antigravity.js';
import { OpenCodeAdapter } from './opencode.js';
import { CustomCliAdapter } from './custom.js';
import type { AgentAdapter, DetectResult } from './types.js';

const DETECT_TIMEOUT_MS = 5000;

export class AgentService {
  readonly adapters: AgentAdapter[];
  private readonly infos = new Map<AgentId, AgentInfo>();
  private readonly infoHandlers = new Set<(info: AgentInfo) => void>();

  constructor(
    private readonly cfg: Config,
    private readonly logger: Logger,
  ) {
    this.adapters = [
      new ClaudeAdapter(cfg.agents.claude),
      new ZCodeAdapter(cfg.agents.zcode),
      new AntigravityAdapter(cfg.agents.antigravity),
      new CodexAdapter(cfg.agents.codex),
      new OpenCodeAdapter(cfg.agents.opencode),
      new CustomCliAdapter(cfg.agents.custom),
    ];
  }

  /** Subscribes to info changes (used for `agent:update` broadcasts). */
  onInfo(handler: (info: AgentInfo) => void): () => void {
    this.infoHandlers.add(handler);
    return () => this.infoHandlers.delete(handler);
  }

  private buildInfo(adapter: AgentAdapter, cfg: ResolvedAgentConfig, detect: DetectResult): AgentInfo {
    const caps = adapter.capabilities();
    const admin = adminCapabilities(adapter.id);
    const defaultModel = adapter.defaultModel?.();
    if (cfg.mode === 'off') {
      return {
        id: adapter.id,
        label: AGENT_LABELS[adapter.id],
        kind: adapter.kind,
        accentColor: AGENT_ACCENTS[adapter.id],
        available: false,
        reason: 'Disabled in config (mode: off)',
        capabilities: { ...caps, headless: false, streaming: false },
        models: MODEL_PRESETS[adapter.id],
        ...(defaultModel ? { defaultModel } : {}),
        ...(adapter.efforts ? { efforts: [...adapter.efforts] } : {}),
        command: cfg.command,
        admin,
      };
    }
    const info: AgentInfo = {
      id: adapter.id,
      label: AGENT_LABELS[adapter.id],
      kind: adapter.kind,
      accentColor: AGENT_ACCENTS[adapter.id],
      available: detect.available,
      capabilities: caps,
      models: adapter.defaultModels(),
      ...(defaultModel ? { defaultModel } : {}),
      ...(adapter.efforts ? { efforts: [...adapter.efforts] } : {}),
      command: cfg.command,
      admin,
    };
    if (detect.version) info.version = detect.version;
    if (!detect.available && detect.reason) info.reason = detect.reason;
    return info;
  }

  /** One capped detection pass for a single adapter + info/broadcast fan-out. */
  private async detectAdapter(adapter: AgentAdapter): Promise<AgentInfo> {
    const cfg = this.cfg.agents[adapter.id];
    let detect: DetectResult;
    try {
      detect = await withTimeoutFallback(
        adapter.detect(),
        DETECT_TIMEOUT_MS,
        { available: false, reason: 'Detection timed out' },
        `${adapter.id} detection`,
      );
    } catch (err) {
      this.logger.warn({ agent: adapter.id, err }, 'agent detection failed');
      detect = { available: false, reason: 'Detection failed' };
    }
    // A live catalog (OpenCode) also supplies the model a run would use.
    // Discovery failure must never make the agent look unavailable.
    if (detect.available && adapter.listModels) {
      try {
        await adapter.listModels();
      } catch (err) {
        this.logger.warn({ agent: adapter.id, err }, 'model discovery failed');
      }
    }
    const info = this.buildInfo(adapter, cfg, detect);
    this.infos.set(adapter.id, info);
    this.logger.info(
      { agent: adapter.id, available: info.available, version: info.version, mode: cfg.mode },
      'agent detected',
    );
    for (const handler of this.infoHandlers) {
      try {
        handler(info);
      } catch {
        // subscriber errors must not break detection
      }
    }
    return info;
  }

  /**
   * Runs all detections in parallel with a hard 5s cap each. Safe to call
   * while the server is already listening; each completion broadcasts.
   */
  async detectAll(): Promise<AgentInfo[]> {
    await Promise.all(this.adapters.map((adapter) => this.detectAdapter(adapter)));
    return this.info();
  }

  /**
   * Re-runs detection for one agent (e.g. right after an admin update/install
   * job) and broadcasts the fresh AgentInfo via the `agent:update` handlers.
   * Adapters hold detection state internally but detect() is written to be
   * safely re-runnable on the same instance (zcode resets `cliDetected`).
   */
  async redetect(id: AgentId): Promise<AgentInfo | undefined> {
    const adapter = this.adapters.find((a) => a.id === id);
    if (!adapter) return undefined;
    return this.detectAdapter(adapter);
  }

  /**
   * Models for the picker. Agents with a live catalog (OpenCode) are asked on
   * demand for `cwd`; everyone else keeps the static presets.
   */
  async modelsFor(id: AgentId, cwd?: string): Promise<ModelCatalog> {
    const fallback: ModelCatalog = { models: MODEL_PRESETS[id] };
    const adapter = this.adapters.find((a) => a.id === id);
    if (!adapter?.listModels) return fallback;
    try {
      const catalog = await withTimeoutFallback(
        adapter.listModels(cwd),
        DETECT_TIMEOUT_MS * 2,
        null,
        `${id} model discovery`,
      );
      return catalog ?? fallback;
    } catch (err) {
      this.logger.warn({ agent: id, err }, 'model discovery failed');
      return fallback;
    }
  }

  /** Visible agent list (mode 'off' agents are hidden per contract). */
  info(): AgentInfo[] {
    return AGENT_IDS.filter((id) => this.cfg.agents[id].mode !== 'off')
      .map((id) => this.infoOf(id))
      .filter((info): info is AgentInfo => info !== undefined);
  }

  /** All agents including disabled ones (used by /api/health). */
  allInfo(): AgentInfo[] {
    return AGENT_IDS.map((id) => this.infoOf(id)).filter((info): info is AgentInfo => info !== undefined);
  }

  /** Current info snapshot; before detection completes this reports unavailable. */
  infoOf(id: AgentId): AgentInfo | undefined {
    const existing = this.infos.get(id);
    if (existing) return existing;
    const adapter = this.adapters.find((a) => a.id === id);
    if (!adapter) return undefined;
    return this.buildInfo(adapter, this.cfg.agents[id], {
      available: false,
      reason: 'Detecting…',
    });
  }

  get(id: AgentId): AgentAdapter | undefined {
    if (this.cfg.agents[id].mode === 'off') return undefined;
    return this.adapters.find((a) => a.id === id);
  }
}

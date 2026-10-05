/**
 * ZCode adapter.
 *
 * Since zcode-cli 0.16.x (github.com/zai-org/ZCode) there is a real headless
 * CLI — verified flags (apps/zcode-cli/packages/cli/src/arguments.ts):
 *   `-p <prompt>` · `--output-format text|json|stream-json` ·
 *   `--mode build|edit|plan|yolo` · `--resume <id>` · `--cwd <dir>` · `--verbose`
 * stdout in stream-json mode is one JSON `SessionEvent` per line:
 *   `{id, sessionId, turnId?, type, timestamp, sequenceNumber, payload}` with
 *   snake_case types (session_created, model_streaming, assistant_message,
 *   tool_call_started, tool_call_result, turn_complete, turn_error, …).
 *
 * Detection: a real CLI answers `--version` with a bare semver and no Electron
 * logs; the desktop AppImage instead logs `[main] … electron initialized` —
 * in that case (or when no binary exists) the adapter stays in IDE mode.
 * Model selection is NOT CLI-driven (no --model flag) → single "inherit"
 * preset; thinking effort is not exposed either.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentCapabilities, AgentEvent, AgentId, AgentPlanOption, ModelPreset, UsageWindow } from '@agentdeck/shared';
import { execa } from 'execa';
import type { ResolvedAgentConfig } from '../config.js';
import { splitCommand } from '../util/cmd.js';
import { withTimeoutFallback } from '../util/async.js';
import { MODEL_PRESETS } from './models.js';
import {
  resolveModelArg,
  summarizeInput,
  type AgentAdapter,
  type DetectResult,
  type RunContext,
  type RunPlan,
} from './types.js';
import { effortArg } from './effort.js';

/** Our permission modes → zcode `--mode` values. */
const MODE_MAP: Record<string, string> = {
  default: 'build',
  acceptEdits: 'edit',
  plan: 'plan',
  bypass: 'yolo',
};

const DESKTOP_MARKERS = /electron initialized|deep-link|crash-capture/i;
const SEMVER = /^\s*v?\d+\.\d+\.\d+/m;

export class ZCodeAdapter implements AgentAdapter {
  readonly id: AgentId = 'zcode';
  readonly label = 'ZCode';
  readonly kind = 'cli' as const;
  readonly accentColor = '#7C5CFF';
  readonly supportsResume = true;
  /** GLM reasoning levels are written as `options.reasoningLevel` in the
   *  provider config (the CLI has no --effort flag). */
  readonly efforts = ['default', 'low', 'medium', 'high'] as const;

  /** Set by detect(): a headless-capable zcode CLI was found. */
  private cliDetected = false;

  /** Non-fatal note when the provider-config write failed (shown as notice). */
  private lastConfigError?: string;

  constructor(private readonly cfg: ResolvedAgentConfig) {}

  async detect(): Promise<DetectResult> {
    const { bin } = splitCommand(this.cfg.command);
    let whichOk = false;
    try {
      const which = await withTimeoutFallback(
        execa('which', [bin], { reject: false }),
        5000,
        null,
        'which zcode',
      );
      whichOk = !!which && which.exitCode === 0;
    } catch {
      whichOk = false;
    }
    if (!whichOk) {
      this.cliDetected = false;
      return { available: false, reason: 'zcode not found on PATH' };
    }

    // Distinguish the headless CLI from the Electron desktop launcher.
    try {
      const res = await withTimeoutFallback(
        execa(bin, ['--version'], { reject: false, stdin: 'ignore' }),
        10_000,
        null,
        'zcode --version',
      );
      const out = `${res?.stdout ?? ''}\n${res?.stderr ?? ''}`;
      const version = (res?.stdout ?? '').match(/\d+\.\d+\.\d+/)?.[0];
      this.cliDetected =
        !!res &&
        res.exitCode === 0 &&
        !!version &&
        SEMVER.test(res.stdout ?? '') &&
        !DESKTOP_MARKERS.test(out);
      if (this.cliDetected) {
        return { available: true, version };
      }
      // Desktop launcher (Electron) — usable as IDE, not headless.
      return { available: true, version: version ?? undefined };
    } catch {
      // Probe failed (e.g. launcher hung) — assume desktop install.
      this.cliDetected = false;
      return { available: true, reason: 'headless probe failed — IDE mode' };
    }
  }

  capabilities(): AgentCapabilities {
    const headless = this.cliDetected || this.cfg.mode === 'headless';
    return {
      headless,
      images: false,
      resume: headless,
      streaming: headless,
      ideLaunch: true,
    };
  }

  defaultModels(): ModelPreset[] {
    return MODEL_PRESETS.zcode;
  }

  buildRun(ctx: RunContext): RunPlan {
    this.lastConfigError = undefined;
    // Model + thinking effort are applied via the shared provider config
    // (defaultModelSelection) — the CLI reads it at startup. Server-wide
    // default; keep the provider binding, swap model/level.
    const modelId = resolveModelArg(ctx.model);
    const level = effortArg(ctx.thinkingEffort);
    if (modelId || level) {
      try {
        applyZcodeModelSelection({ ...(modelId ? { modelId } : {}), ...(level ? { reasoningLevel: level } : {}) });
      } catch (err) {
        this.lastConfigError = err instanceof Error ? err.message : String(err);
      }
    }
    const promptParts: string[] = [ctx.text];
    for (const att of ctx.attachments) {
      promptParts.push(`\n[Attached file: ${att.path} (${att.mime})]`);
    }
    const args = [
      '-p',
      promptParts.join('\n'),
      '--output-format',
      'stream-json',
      '--verbose',
      '--mode',
      MODE_MAP[ctx.permissionMode] ?? 'build',
    ];
    if (ctx.resumeId) args.push('--resume', ctx.resumeId);
    const { bin, prefixArgs } = splitCommand(this.cfg.command);
    const parser = createZcodeStreamParser();
    return {
      command: bin,
      args: [...prefixArgs, ...args],
      // The standalone agent requires explicit provider-config paths.
      env: zcodeProviderEnv(),
      stdinPayloads: null,
      expectStream: true,
      ...(this.lastConfigError
        ? { notice: `Could not apply model/effort to the ZCode config (${this.lastConfigError}) — running with the current default.` }
        : {}),
      parse: (line, emit) => parser.parse(line, emit),
    };
  }

  externalSessionIdOf(line: string): string | undefined {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      // All events of a run share the envelope sessionId; capture it from
      // creation/resume events explicitly, else from any event (first wins).
      const sid =
        (parsed.payload as Record<string, unknown> | undefined)?.sessionId ?? parsed.sessionId;
      if (typeof sid === 'string' && sid.startsWith('sess_')) return sid;
    } catch {
      /* not json */
    }
    return undefined;
  }

  ideCommand(projectPath: string): { command: string; args: string[] } | null {
    const configured = this.cfg.ideCommand ?? this.cfg.command;
    const { bin, prefixArgs } = splitCommand(configured);
    return { command: bin, args: [...prefixArgs, projectPath] };
  }
}

/** Provider-config env for the standalone agent (builtin + personal paths). */
export function zcodeProviderEnv(): Record<string, string> {
  const home = os.homedir();
  return {
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: path.join(home, '.zcode/runtime/agent/provider/zcode-builtin.json'),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(home, '.zcode/v2/provider_config.json'),
  };
}

/** Path of the personal provider config (also used by tests via injection). */
export function zcodeProviderConfigPath(): string {
  return path.join(os.homedir(), '.zcode/v2/provider_config.json');
}

export interface ZcodeModelSelectionPatch {
  modelId?: string;
  reasoningLevel?: string;
}

/**
 * Applies model + reasoning level to the shared `defaultModelSelection` in
 * the personal provider config. The CLI exposes no --model/--effort flags —
 * it reads this file at startup. Preserves an existing provider binding.
 * Atomic (temp file + rename). Throws on unreadable/unwritable config.
 */
export function applyZcodeModelSelection(
  patch: ZcodeModelSelectionPatch,
  filePath = zcodeProviderConfigPath(),
): void {
  const current = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  const prev = (current.defaultModelSelection ?? {}) as Record<string, unknown>;
  const providerId =
    typeof prev.providerId === 'string' && prev.providerId
      ? prev.providerId
      : 'account:zai-individual-coding-plan';
  const modelId = patch.modelId ?? (typeof prev.modelId === 'string' ? prev.modelId : 'GLM-5.3');
  const prevOptions = (prev.options ?? {}) as Record<string, unknown>;
  const options = { ...prevOptions };
  if (patch.reasoningLevel) options.reasoningLevel = patch.reasoningLevel;
  else delete options.reasoningLevel;
  current.defaultModelSelection = {
    providerId,
    modelId,
    ...(Object.keys(options).length ? { options } : {}),
  };
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.agentdeck-prov-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function writeAtomicJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.agentdeck-${path.basename(filePath)}-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Switch ZCode plan between subscription (individual-coding-plan) and
 * free tokens (start-plan). Atomically updates provider_config.json,
 * setting.json and config.json.
 */
export function switchZcodePlan(
  target: 'subscription' | 'free',
  v2Dir = path.join(os.homedir(), '.zcode/v2'),
): void {
  const provPath = path.join(v2Dir, 'provider_config.json');
  const settPath = path.join(v2Dir, 'setting.json');
  const cfgPath = path.join(v2Dir, 'config.json');

  if (!fs.existsSync(provPath)) {
    throw new Error(`ZCode provider config not found at ${provPath}`);
  }

  // 1. provider_config.json
  const prov = JSON.parse(fs.readFileSync(provPath, 'utf8')) as Record<string, unknown>;
  const prevSel = (prov.defaultModelSelection ?? {}) as Record<string, unknown>;
  if (target === 'free') {
    prov.defaultModelSelection = {
      ...prevSel,
      providerId: 'account:zai-start-plan',
      // Start-plan only supports Flash models
      modelId: 'GLM-5.3-Flash',
    };
  } else {
    prov.defaultModelSelection = {
      ...prevSel,
      providerId: 'account:zai-individual-coding-plan',
      modelId: prevSel.modelId ?? 'GLM-5.3',
    };
  }
  writeAtomicJson(provPath, prov);

  // 2. setting.json (if exists)
  if (fs.existsSync(settPath)) {
    try {
      const sett = JSON.parse(fs.readFileSync(settPath, 'utf8')) as Record<string, unknown>;
      const keys = (sett.modelProviderFamilySelectedKeys ?? {}) as Record<string, string>;
      const selections = (sett.providerFamilyConnectionSelections ?? {}) as Record<string, unknown>;

      if (target === 'free') {
        keys.zai = 'coding-plan:builtin:zai-start-plan';
        selections.zai = { kind: 'start-plan' };
      } else {
        keys.zai = 'coding-plan:builtin:zai-coding-plan';
        selections.zai = { kind: 'individual-coding-plan' };
      }
      sett.modelProviderFamilySelectedKeys = keys;
      sett.providerFamilyConnectionSelections = selections;
      sett.providerFamilyDomain = 'zai';
      writeAtomicJson(settPath, sett);
    } catch {
      /* non-fatal setting sync */
    }
  }

  // 3. config.json (if exists)
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
      const providers = (cfg.provider ?? {}) as Record<string, Record<string, unknown>>;
      if (providers['builtin:zai-coding-plan']) {
        providers['builtin:zai-coding-plan'].enabled = target === 'subscription';
      }
      if (providers['builtin:zai-start-plan']) {
        providers['builtin:zai-start-plan'].enabled = target === 'free';
      }
      writeAtomicJson(cfgPath, cfg);
    } catch {
      /* non-fatal config sync */
    }
  }
}

export interface ZcodePlanDetails {
  activePlanId: 'subscription' | 'free';
  activePlanLabel: string;
  plans: AgentPlanOption[];
  session?: UsageWindow;
  week?: UsageWindow;
  raw?: string;
}

/**
 * Reset instant as an ISO string — the app formats it in the device's timezone
 * (the server's own timezone is often UTC and would show the wrong clock time).
 */
export function formatResetTime(ms?: number | null, now = Date.now()): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined;
  if (ms - now <= 0) return 'abgelaufen';
  return new Date(ms).toISOString();
}

/**
 * Reads ZCode plans (both subscription and free start-plan tokens),
 * querying the respective APIs when keys exist and falling back to cached disk info.
 */
export async function getZcodePlanInfo(
  v2Dir = path.join(os.homedir(), '.zcode/v2'),
  dbFile = path.join(os.homedir(), '.zcode/cli/db/db.sqlite'),
): Promise<ZcodePlanDetails> {
  const provPath = path.join(v2Dir, 'provider_config.json');
  const cfgPath = path.join(v2Dir, 'config.json');

  let activePlanId: 'subscription' | 'free' = 'subscription';
  if (fs.existsSync(provPath)) {
    try {
      const prov = JSON.parse(fs.readFileSync(provPath, 'utf8')) as Record<string, unknown>;
      const sel = (prov.defaultModelSelection ?? {}) as Record<string, unknown>;
      const providerId = String(sel.providerId ?? '');
      if (providerId.includes('start-plan')) activePlanId = 'free';
    } catch {
      /* default to subscription */
    }
  }

  let subApiKey: string | undefined;
  let startApiKey: string | undefined;

  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
      const providers = (cfg.provider ?? {}) as Record<string, Record<string, unknown>>;
      const subOpts = (providers['builtin:zai-coding-plan']?.options ?? {}) as Record<string, unknown>;
      const startOpts = (providers['builtin:zai-start-plan']?.options ?? {}) as Record<string, unknown>;
      if (typeof subOpts.apiKey === 'string' && subOpts.apiKey) subApiKey = subOpts.apiKey;
      if (typeof startOpts.apiKey === 'string' && startOpts.apiKey) startApiKey = startOpts.apiKey;
    } catch {
      /* ignore */
    }
  }

  let subLabel = 'GLM Coding Lite (Abo)';
  let subStatus = 'VALID';
  let subDetail = 'Monatliches Abo (GLM Coding Plan)';
  let subRenewDate: string | undefined;
  let subSessionWindow: UsageWindow | undefined;
  let subWeekWindow: UsageWindow | undefined;

  if (subApiKey) {
    await Promise.allSettled([
      (async () => {
        try {
          const res = await fetch('https://api.z.ai/api/biz/subscription/list', {
            headers: { Authorization: subApiKey },
            signal: AbortSignal.timeout(4000),
          });
          if (res.ok) {
            const json = (await res.json()) as { code?: number; data?: Array<Record<string, unknown>> };
            if (json.code === 200 && Array.isArray(json.data) && json.data[0]) {
              const item = json.data[0];
              if (typeof item.productName === 'string') subLabel = `${item.productName} (Abo)`;
              if (typeof item.status === 'string') subStatus = item.status;
              if (typeof item.nextRenewTime === 'string') subRenewDate = item.nextRenewTime;
              const cycle = item.billingCycle === 'monthly' ? 'Monatlich' : String(item.billingCycle ?? 'Abo');
              subDetail = `${cycle} · Status: ${subStatus}${subRenewDate ? ` · Verlängerung: ${subRenewDate}` : ''}`;
            }
          }
        } catch {
          /* network timeout or offline */
        }
      })(),
      (async () => {
        try {
          const res = await fetch('https://api.z.ai/api/monitor/usage/quota/limit', {
            headers: { authorization: subApiKey },
            signal: AbortSignal.timeout(4000),
          });
          if (res.ok) {
            const json = (await res.json()) as {
              code?: number;
              data?: {
                limits?: Array<{
                  type?: string;
                  unit?: number;
                  number?: number;
                  percentage?: number;
                  nextResetTime?: number;
                  currentValue?: number;
                  usage?: number;
                  remaining?: number;
                }>;
              };
            };
            if (json.code === 200 && Array.isArray(json.data?.limits)) {
              const limits = json.data.limits;
              const lim5h = limits.find((l) => (l.unit === 3 && l.number === 5) || l.number === 5);
              const limWk = limits.find((l) => (l.unit === 6 && l.number === 1) || l.unit === 6 || (l.number === 1 && l.unit !== 3));
              if (lim5h && typeof lim5h.percentage === 'number') {
                subSessionWindow = {
                  pct: lim5h.percentage,
                  resetsAt: formatResetTime(lim5h.nextResetTime),
                };
              }
              if (limWk && typeof limWk.percentage === 'number') {
                subWeekWindow = {
                  pct: limWk.percentage,
                  resetsAt: formatResetTime(limWk.nextResetTime),
                };
              }
            }
          }
        } catch {
          /* network timeout or offline */
        }
      })(),
    ]);
  }

  let freeLabel = 'ZCode Free Tokens (Start-Plan)';
  let freeStatus = 'active';
  let freeDetail = 'Free Usage Tokens';
  let freeTokens: number | undefined;
  let freeEndsAt: string | undefined;
  let freeStartsAtSec: number | undefined;
  let freeEndsAtSec: number | undefined;
  let freeWeekWindow: UsageWindow | undefined;

  if (startApiKey) {
    try {
      const res = await fetch('https://zcode.z.ai/api/v1/zcode-plan/billing/current?app_version=0.16.9', {
        headers: { Authorization: `Bearer ${startApiKey}` },
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const json = (await res.json()) as {
          code?: number;
          data?: { plans?: Array<{ name?: string; status?: string; starts_at?: number; ends_at?: number; entitlements?: Array<{ grant_units?: number }> }> };
        };
        if (json.code === 0 && json.data?.plans?.[0]) {
          const p = json.data.plans[0];
          if (p.name) freeLabel = `${p.name} (Free Tokens)`;
          if (p.status) freeStatus = p.status;
          const units = p.entitlements?.[0]?.grant_units;
          if (typeof units === 'number') freeTokens = units;
          if (typeof p.starts_at === 'number') freeStartsAtSec = p.starts_at;
          if (typeof p.ends_at === 'number' && p.ends_at > 0) {
            freeEndsAtSec = p.ends_at;
            freeEndsAt = new Date(p.ends_at * 1000).toISOString();
          }
          const mTokens = freeTokens ? `${(freeTokens / 1_000_000).toFixed(0)}M Tokens` : 'Free Tokens';
          // the expiry itself is shown by the app in device time (resetsAt)
          freeDetail = `${mTokens} · Status: ${freeStatus}`;
        }
      }
    } catch {
      /* network timeout or offline */
    }
  }

  // Calculate free token usage if we have start date & sqlite turn_usage
  if (freeTokens && freeTokens > 0) {
    let usedTokens = 0;
    try {
      if (fs.existsSync(dbFile)) {
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(dbFile, { readOnly: true });
        try {
          const sinceMs = (freeStartsAtSec ?? 0) * 1000;
          const row = db.prepare('SELECT SUM(input_tokens + output_tokens) as total FROM turn_usage WHERE started_at >= ?').get(sinceMs) as { total?: number } | undefined;
          usedTokens = Number(row?.total ?? 0);
        } finally {
          db.close();
        }
      }
    } catch {
      /* sqlite read error non-fatal */
    }
    const usedPct = Math.min(100, Math.round((usedTokens / freeTokens) * 100));
    freeWeekWindow = {
      pct: usedPct,
      resetsAt: formatResetTime(freeEndsAtSec ? freeEndsAtSec * 1000 : undefined),
    };
  }

  const plans: AgentPlanOption[] = [
    {
      id: 'subscription',
      label: subLabel,
      active: activePlanId === 'subscription',
      status: subStatus,
      detail: subDetail,
      resetsAt: subRenewDate,
      session: subSessionWindow,
      week: subWeekWindow,
      models: ['GLM-5.3', 'GLM-5.3-Flash'],
    },
    {
      id: 'free',
      label: freeLabel,
      active: activePlanId === 'free',
      status: freeStatus,
      detail: freeDetail,
      tokens: freeTokens,
      resetsAt: freeEndsAt,
      session: undefined,
      week: freeWeekWindow,
      models: ['GLM-5.3-Flash'],
    },
  ];

  const activePlan = plans.find((p) => p.id === activePlanId) ?? plans[0];

  return {
    activePlanId,
    activePlanLabel: activePlan.label,
    plans,
    session: activePlan.session,
    week: activePlan.week,
    raw: `Active Plan: ${activePlanId} (${activePlan.label})\nSubscription: ${subDetail} [5h: ${subSessionWindow?.pct ?? '?'}% reset ${subSessionWindow?.resetsAt ?? '?'}, week: ${subWeekWindow?.pct ?? '?'}% reset ${subWeekWindow?.resetsAt ?? '?'}]\nFree Tokens: ${freeDetail} [quota used: ${freeWeekWindow?.pct ?? '?'}% reset ${freeWeekWindow?.resetsAt ?? '?'}]`,
  };
}

/** Reads recent activity from ZCode's SQLite turn_usage table if available. */
export async function readZcodeSqliteStats(
  dbFile = path.join(os.homedir(), '.zcode/cli/db/db.sqlite'),
  now = Date.now(),
): Promise<{ last24h?: UsageWindow; last7d?: UsageWindow }> {
  try {
    if (!fs.existsSync(dbFile)) return {};
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const dayAgo = now - 24 * 3600 * 1000;
      const weekAgo = now - 7 * 24 * 3600 * 1000;
      const q24 = db.prepare('SELECT COUNT(*) as cnt, COUNT(DISTINCT session_id) as sess FROM turn_usage WHERE started_at >= ?').get(dayAgo) as { cnt?: number; sess?: number } | undefined;
      const q7 = db.prepare('SELECT COUNT(*) as cnt, COUNT(DISTINCT session_id) as sess FROM turn_usage WHERE started_at >= ?').get(weekAgo) as { cnt?: number; sess?: number } | undefined;
      return {
        ...(q24 && q24.cnt !== undefined ? { last24h: { requests: Number(q24.cnt), sessions: Number(q24.sess ?? 0) } } : {}),
        ...(q7 && q7.cnt !== undefined ? { last7d: { requests: Number(q7.cnt), sessions: Number(q7.sess ?? 0) } } : {}),
      };
    } finally {
      db.close();
    }
  } catch {
    return {};
  }
}

const LOGIN_HINT =
  'ZCode has no model configured yet — run `zcode login zai` once on this machine (opens the browser), then retry.';

// ---------------------------------------------------------------------------
// stream-json parser (SessionEvent lines, defensive payload extraction)
// ---------------------------------------------------------------------------

interface ZcodeEvent {
  type?: string;
  payload?: unknown;
}

function safeJson(line: string): ZcodeEvent | undefined {
  try {
    const v = JSON.parse(line) as unknown;
    return typeof v === 'object' && v !== null ? (v as ZcodeEvent) : undefined;
  } catch {
    return undefined;
  }
}

/** Reasoning deltas sometimes nest under a `reasoning` key without text/delta
 *  markers — pull the first string out of that subtree only. */
function extractReasoningDeep(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value === null || value === undefined || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const subtree = obj.reasoning ?? obj.delta ?? obj.text ?? value;
  if (typeof subtree === 'string') return subtree.length ? subtree : undefined;
  if (typeof subtree === 'object') {
    for (const v of Object.values(subtree as Record<string, unknown>)) {
      const found = extractReasoningDeep(v, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/** Recursively find a text/delta/content STRING — never falls back to ids. */
function extractText(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value === null || value === undefined) return undefined;
  if (typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of ['text', 'delta', 'content']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length) return v;
  }
  for (const v of Object.values(obj)) {
    const found = extractText(v, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function extractToolName(payload: unknown): string {
  const obj = payload as Record<string, unknown> | undefined;
  const name = obj?.toolName ?? obj?.name ?? obj?.tool;
  return typeof name === 'string' && name ? name : 'tool';
}

function extractUsage(payload: unknown): {
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
} {
  const usage: { inputTokens?: number; outputTokens?: number; model?: string } = {};
  const obj = payload as Record<string, unknown> | undefined;
  const src = (obj?.usage ?? obj?.summary ?? payload) as Record<string, unknown> | undefined;
  if (src && typeof src === 'object') {
    const inp = src.inputTokens ?? src.input_tokens ?? src.tokensIn;
    const out = src.outputTokens ?? src.output_tokens ?? src.tokensOut;
    if (typeof inp === 'number') usage.inputTokens = inp;
    if (typeof out === 'number') usage.outputTokens = out;
  }
  if (obj && typeof obj.model === 'string') usage.model = obj.model;
  return usage;
}

export function createZcodeStreamParser() {
  let sawTextDelta = false;

  function parse(line: string, emit: (event: AgentEvent) => void): void {
    if (!line.trim()) return;
    const parsed = safeJson(line);
    if (!parsed) {
      emit({ type: 'raw', line });
      return;
    }
    // Wire format uses dot-notation ("turn.failed"), the contracts enum
    // snake_case ("turn_failed") — normalize both.
    const type = String(parsed.type ?? '').replace(/\./g, '_');
    const payload = parsed.payload;

    switch (type) {
      case 'session_created':
      case 'session_resumed':
        emit({ type: 'status', status: 'running', detail: 'ZCode session initialized' });
        return;
      case 'model_streaming': {
        // ModelStreamingPayload { delta, done, kind?: 'text_delta'|'reasoning_delta'|… }
        // — reasoning MUST stay out of the answer text (kind discriminates).
        const obj = payload as Record<string, unknown> | undefined;
        const kind = typeof obj?.kind === 'string' ? obj.kind : '';
        const delta = typeof obj?.delta === 'string' ? obj.delta : '';
        if (kind === 'reasoning_delta') {
          if (delta) emit({ type: 'thinking-delta', text: delta });
          return;
        }
        if (kind === 'text_delta' || kind === '' || kind === 'start' || kind === 'finish') {
          if (kind === 'text_delta' && delta) {
            sawTextDelta = true;
            emit({ type: 'text-delta', text: delta });
          }
          return;
        }
        // text_start/text_end/reasoning_start/reasoning_end/tool_input_*/tool_call/error:
        // structure only — tool cards arrive via their own events.
        return;
      }
      case 'reasoning_start':
      case 'reasoning_end':
        // Structure only — the deltas carry the content.
        return;
      case 'reasoning_delta': {
        const text = extractText(payload) ?? extractReasoningDeep(payload);
        if (text) emit({ type: 'thinking-delta', text });
        return;
      }
      case 'assistant_message': {
        // Full message — only surface when streaming deltas never came.
        if (sawTextDelta) return;
        const text = extractText(payload);
        if (text) emit({ type: 'text-delta', text });
        return;
      }
      case 'tool_call_started':
      case 'tool_call_scheduled': {
        emit({ type: 'tool-use', tool: extractToolName(payload), summary: summarizeInput((payload as Record<string, unknown> | undefined)?.input) });
        return;
      }
      case 'tool_call_result':
      case 'tool_call_error': {
        const obj = payload as Record<string, unknown> | undefined;
        const ok = parsed.type === 'tool_call_result' && !obj?.error;
        emit({
          type: 'tool-result',
          tool: extractToolName(payload),
          ok,
          summary: summarizeInput(obj?.result ?? obj?.error ?? obj?.summary),
        });
        return;
      }
      case 'turn_complete': {
        const usage = extractUsage(payload);
        emit({ type: 'usage', ...usage });
        return;
      }
      case 'turn_error':
      case 'turn.failed':
      case 'model_error': {
        const raw = extractText((payload as Record<string, unknown> | undefined)?.error) ??
          extractText(payload) ??
          'ZCode reported an error';
        const message = /select a model/i.test(raw) ? LOGIN_HINT : raw;
        emit({ type: 'status', status: 'error', detail: message.slice(0, 300) });
        emit({ type: 'raw', line });
        return;
      }
      default:
        // Interesting-but-unmapped events stay visible in the raw stream.
        emit({ type: 'raw', line });
        return;
    }
  }

  return { parse };
}

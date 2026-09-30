/**
 * Configuration: defaults per CONTRACT.md, deep-merged with
 * `~/.config/agentdeck/config.json`, then overridden by `AGENTDECK_*` env vars.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { expandHome } from './util/paths.js';

export type AgentMode = 'headless' | 'ide' | 'auto' | 'off';

export const AGENT_MODES: AgentMode[] = ['headless', 'ide', 'auto', 'off'];

export const AGENT_IDS = ['claude', 'zcode', 'antigravity', 'codex'] as const;

const AgentConfigSchema = z.object({
  mode: z.enum(['headless', 'ide', 'auto', 'off']).default('auto'),
  command: z.string().min(1),
  ideCommand: z.string().optional(),
});

export const TunnelConfigSchema = z.object({
  provider: z.enum(['cloudflared', 'off']).default('off'),
  mode: z.enum(['quick', 'token', 'named']).default('quick'),
  token: z.string().default(''),
  /** Named tunnel name (mode "named") — fixed URL, no dashboard token needed. */
  name: z.string().default(''),
  /** Optional credentials file override for mode "named". */
  credentialsFile: z.string().default(''),
  hostname: z.string().default(''),
  binary: z.string().default('cloudflared'),
});

export const VoiceConfigSchema = z.object({
  provider: z.enum(['auto', 'openai', 'groq', 'command', 'off']).default('auto'),
  /** API key (falls back to OPENAI_API_KEY / GROQ_API_KEY). */
  apiKey: z.string().default(''),
  /** OpenAI-compatible base URL (provider openai). */
  baseUrl: z.string().default(''),
  model: z.string().default(''),
  /** Local transcriber command; {wav}/{file}/{lang} placeholders. */
  command: z.string().default(''),
  /** Default language hint (ISO 639-1), empty = auto / device language. */
  language: z.string().default(''),
});

export const ConfigSchema = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().int().min(0).max(65535).default(8787),
  dataDir: z.string().default('~/.local/share/agentdeck'),
  projectsRoot: z.string().optional(),
  serverName: z.string().default(os.hostname()),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  maxRunMs: z.number().int().min(1000).default(1_800_000),
  maxUploadBytes: z.number().int().min(1024).default(20 * 1024 * 1024),
  maxApkBytes: z.number().int().min(1024).default(200 * 1024 * 1024),
  tunnel: TunnelConfigSchema.default({}),
  voice: VoiceConfigSchema.default({}),
  corsOrigins: z
    .array(z.string())
    .default(['http://localhost:5173', 'capacitor://localhost', 'http://localhost', 'https://localhost']),
  agents: z
    .object({
      claude: AgentConfigSchema.default({ mode: 'headless', command: 'claude' }),
      zcode: AgentConfigSchema.default({ mode: 'auto', command: 'zcode' }),
      antigravity: AgentConfigSchema.default({
        mode: 'auto',
        command: 'flatpak run --command=antigravity com.google.Antigravity',
        ideCommand: 'flatpak run com.google.Antigravity',
      }),
      codex: AgentConfigSchema.default({ mode: 'headless', command: 'codex' }),
    })
    .default({}),
});

export type ResolvedAgentConfig = z.infer<typeof AgentConfigSchema>;
export type ResolvedTunnelConfig = z.infer<typeof TunnelConfigSchema>;

/** Fully resolved configuration (paths absolutized, projectsRoot defaulted). */
export interface Config extends Omit<z.infer<typeof ConfigSchema>, 'dataDir' | 'projectsRoot'> {
  dataDir: string;
  projectsRoot: string;
}

/** Plain-object deep merge; override values win. Arrays are replaced wholesale. */
export function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = out[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      out[key] = deepMerge(current as Record<string, unknown>, value as Record<string, unknown>);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

function envOverrides(env: Record<string, string | undefined>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  const str = (name: string): string | undefined => {
    const v = env[name];
    return v === undefined || v === '' ? undefined : v;
  };
  const num = (name: string): number | undefined => {
    const v = str(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const host = str('AGENTDECK_HOST');
  if (host !== undefined) o.host = host;
  const port = num('AGENTDECK_PORT');
  if (port !== undefined) o.port = port;
  const dataDir = str('AGENTDECK_DATA_DIR');
  if (dataDir !== undefined) o.dataDir = dataDir;
  const projectsRoot = str('AGENTDECK_PROJECTS_ROOT');
  if (projectsRoot !== undefined) o.projectsRoot = projectsRoot;
  const serverName = str('AGENTDECK_SERVER_NAME');
  if (serverName !== undefined) o.serverName = serverName;
  const logLevel = str('AGENTDECK_LOG_LEVEL');
  if (logLevel !== undefined) o.logLevel = logLevel;
  const maxRunMs = num('AGENTDECK_MAX_RUN_MS');
  if (maxRunMs !== undefined) o.maxRunMs = maxRunMs;
  const maxUploadBytes = num('AGENTDECK_MAX_UPLOAD_BYTES');
  if (maxUploadBytes !== undefined) o.maxUploadBytes = maxUploadBytes;
  const maxApkBytes = num('AGENTDECK_MAX_APK_BYTES');
  if (maxApkBytes !== undefined) o.maxApkBytes = maxApkBytes;
  const tunnel: Record<string, unknown> = {};
  const tunnelProvider = str('AGENTDECK_TUNNEL');
  if (tunnelProvider !== undefined) tunnel.provider = tunnelProvider;
  const tunnelToken = str('AGENTDECK_TUNNEL_TOKEN');
  if (tunnelToken !== undefined) {
    tunnel.token = tunnelToken;
    tunnel.mode = 'token'; // a token implies token mode per contract
  }
  const tunnelBinary = str('AGENTDECK_TUNNEL_BINARY');
  if (tunnelBinary !== undefined) tunnel.binary = tunnelBinary;
  if (Object.keys(tunnel).length > 0) o.tunnel = tunnel;
  const voice: Record<string, unknown> = {};
  const voiceProvider = str('AGENTDECK_VOICE_PROVIDER');
  if (voiceProvider !== undefined) voice.provider = voiceProvider;
  const voiceCommand = str('AGENTDECK_VOICE_COMMAND');
  if (voiceCommand !== undefined) voice.command = voiceCommand;
  const voiceKey = str('AGENTDECK_VOICE_API_KEY');
  if (voiceKey !== undefined) voice.apiKey = voiceKey;
  const voiceModel = str('AGENTDECK_VOICE_MODEL');
  if (voiceModel !== undefined) voice.model = voiceModel;
  if (Object.keys(voice).length > 0) o.voice = voice;
  const cors = str('AGENTDECK_CORS_ORIGINS');
  if (cors !== undefined) {
    if (cors.trim().startsWith('[')) {
      try {
        o.corsOrigins = JSON.parse(cors);
      } catch {
        o.corsOrigins = cors.split(',').map((s) => s.trim()).filter(Boolean);
      }
    } else {
      o.corsOrigins = cors.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  const agents: Record<string, unknown> = {};
  for (const id of AGENT_IDS) {
    const key = id.toUpperCase();
    const mode = str(`AGENTDECK_AGENT_${key}_MODE`);
    const command = str(`AGENTDECK_AGENT_${key}_COMMAND`);
    const ideCommand = str(`AGENTDECK_AGENT_${key}_IDE_COMMAND`);
    const cfg: Record<string, unknown> = {};
    if (mode !== undefined) cfg.mode = mode;
    if (command !== undefined) cfg.command = command;
    if (ideCommand !== undefined) cfg.ideCommand = ideCommand;
    if (Object.keys(cfg).length > 0) agents[id] = cfg;
  }
  if (Object.keys(agents).length > 0) o.agents = agents;
  return o;
}

export interface LoadConfigOptions {
  /** Environment variables to consult (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Directory holding config.json (defaults to ~/.config/agentdeck). */
  configDir?: string;
}

export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const env = opts.env ?? process.env;
  const configDir = expandHome(opts.configDir ?? '~/.config/agentdeck');
  let fileJson: Record<string, unknown> = {};
  const configFile = path.join(configDir, 'config.json');
  if (fs.existsSync(configFile)) {
    const raw = fs.readFileSync(configFile, 'utf8');
    try {
      fileJson = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `Invalid AgentDeck config file at ${configFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const merged = deepMerge(deepMerge({}, fileJson), envOverrides(env));
  const parsed = ConfigSchema.parse(merged);
  if (
    parsed.tunnel.provider === 'cloudflared' &&
    parsed.tunnel.mode === 'token' &&
    parsed.tunnel.token.trim() === ''
  ) {
    throw new Error(
      "Invalid AgentDeck config: tunnel.mode 'token' requires a cloudflared tunnel token. " +
        'Set `tunnel.token` in config.json or the AGENTDECK_TUNNEL_TOKEN env var.',
    );
  }
  if (
    parsed.tunnel.provider === 'cloudflared' &&
    parsed.tunnel.mode === 'named' &&
    parsed.tunnel.name.trim() === ''
  ) {
    throw new Error(
      "Invalid AgentDeck config: tunnel.mode 'named' requires a tunnel name. " +
        'Run scripts/setup-tunnel.sh or set `tunnel.name` in config.json ' +
        '(after `cloudflared tunnel login` + `cloudflared tunnel create <name>`).',
    );
  }
  const dataDir = path.resolve(expandHome(parsed.dataDir));
  const projectsRoot = path.resolve(expandHome(parsed.projectsRoot ?? path.join(dataDir, 'projects')));
  return { ...parsed, dataDir, projectsRoot };
}

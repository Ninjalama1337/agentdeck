import path from 'node:path';
import type { ServerCliInfo, ServiceCliStatus } from './contract';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Runs a program to completion. Never rejects for a non-zero exit — only for "could not run at all". */
export type Exec = (file: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

/** The CLI failed: exit code != 0, unusable output, or it could not be started. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null = null,
    readonly stderr = '',
  ) {
    super(message);
    this.name = 'CliError';
  }
}

const INFO_TIMEOUT_MS = 20_000;
const SERVICE_TIMEOUT_MS = 40_000;
/** Install copies the whole runtime (~200 MB) — give it room. */
const INSTALL_TIMEOUT_MS = 180_000;

export interface InstallOptions {
  lan?: boolean;
  port?: number;
  /** Write and enable the unit but do not start it. */
  noStart?: boolean;
}

/** What failed: the `{"error": …}` document a `--json` call prints, else the last stderr lines. */
function errorText(result: ExecResult): string {
  try {
    const body = JSON.parse(result.stdout.trim()) as { error?: unknown } | null;
    if (typeof body?.error === 'string' && body.error) return body.error;
  } catch {
    /* not JSON */
  }
  const text = (result.stderr || result.stdout).trim().split('\n').slice(-6).join('\n').trim();
  return text || `exit code ${result.code}`;
}

/** JSON on stdout; tolerates stray lines around the object (a warning from node, say). */
export function parseJsonOutput(stdout: string): unknown {
  const text = stdout.trim();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as unknown;
      } catch {
        /* fall through */
      }
    }
    throw new CliError(`Unexpected output from agentdeck-server: ${text.slice(0, 200) || '(empty)'}`);
  }
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError(`agentdeck-server ${what}: expected a JSON object`);
  }
  return value as Record<string, unknown>;
}

function str(rec: Record<string, unknown>, key: string, what: string): string {
  const value = rec[key];
  if (typeof value !== 'string' || value === '') throw new CliError(`agentdeck-server ${what}: "${key}" is missing`);
  return value;
}

export function parseServerInfo(raw: unknown): ServerCliInfo {
  const rec = asRecord(raw, 'info');
  const port = rec.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError('agentdeck-server info: "port" is not a valid port');
  }
  return {
    version: str(rec, 'version', 'info'),
    packaged: rec.packaged === true,
    dataDir: str(rec, 'dataDir', 'info'),
    configPath: typeof rec.configPath === 'string' ? rec.configPath : '',
    host: typeof rec.host === 'string' && rec.host ? rec.host : '127.0.0.1',
    port,
    pairingCodeFile: str(rec, 'pairingCodeFile', 'info'),
    pidFile: str(rec, 'pidFile', 'info'),
    ...(typeof rec.webDist === 'string' ? { webDist: rec.webDist } : {}),
  };
}

export function parseServiceStatus(raw: unknown): ServiceCliStatus {
  const rec = asRecord(raw, 'service status');
  const flag = (key: string): boolean => rec[key] === true;
  return {
    systemd: flag('systemd'),
    installed: flag('installed'),
    managed: flag('managed'),
    enabled: flag('enabled'),
    active: flag('active'),
    ...(typeof rec.mainPid === 'number' ? { mainPid: rec.mainPid } : {}),
    unitPath: typeof rec.unitPath === 'string' ? rec.unitPath : '',
    lan: flag('lan'),
    ...(typeof rec.runtimeVersion === 'string' && rec.runtimeVersion ? { runtimeVersion: rec.runtimeVersion } : {}),
  };
}

export interface ServerCli {
  readonly bin: string;
  info(): Promise<ServerCliInfo>;
  serviceStatus(): Promise<ServiceCliStatus>;
  serviceInstall(options?: InstallOptions): Promise<void>;
  serviceUninstall(): Promise<void>;
  serviceStart(): Promise<void>;
  serviceStop(): Promise<void>;
  serviceRestart(): Promise<void>;
}

/**
 * Thin wrapper over the `agentdeck-server` CLI. Every call asks for `--json`: stdout carries one
 * document (the service status, or `{"error": …}` on failure), progress goes to stderr.
 */
export function createCli(options: { bin: string; exec: Exec; env?: NodeJS.ProcessEnv }): ServerCli {
  const { bin, exec, env } = options;

  async function run(args: string[], timeoutMs: number): Promise<ExecResult> {
    let result: ExecResult;
    try {
      result = await exec(bin, args, { timeoutMs, ...(env ? { env } : {}) });
    } catch (err) {
      throw new CliError(`Cannot run ${path.basename(bin)}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (result.code !== 0) {
      throw new CliError(`agentdeck-server ${args.slice(0, 2).join(' ')} failed: ${errorText(result)}`, result.code, result.stderr);
    }
    return result;
  }

  return {
    bin,
    async info() {
      return parseServerInfo(parseJsonOutput((await run(['info', '--json'], INFO_TIMEOUT_MS)).stdout));
    },
    async serviceStatus() {
      return parseServiceStatus(parseJsonOutput((await run(['service', 'status', '--json'], INFO_TIMEOUT_MS)).stdout));
    },
    async serviceInstall(opts = {}) {
      const args = ['service', 'install'];
      if (opts.lan) args.push('--lan');
      if (opts.port !== undefined) args.push('--port', String(opts.port));
      if (opts.noStart) args.push('--no-start');
      await run([...args, '--json'], INSTALL_TIMEOUT_MS);
    },
    async serviceUninstall() {
      await run(['service', 'uninstall', '--json'], SERVICE_TIMEOUT_MS);
    },
    async serviceStart() {
      await run(['service', 'start', '--json'], SERVICE_TIMEOUT_MS);
    },
    async serviceStop() {
      await run(['service', 'stop', '--json'], SERVICE_TIMEOUT_MS);
    },
    async serviceRestart() {
      await run(['service', 'restart', '--json'], SERVICE_TIMEOUT_MS);
    },
  };
}

export type ServerBinSource = 'env' | 'bundled' | 'dev-bundle';

export interface ResolvedServerBin {
  bin: string;
  source: ServerBinSource;
}

export class ServerBinNotFoundError extends Error {
  constructor(readonly tried: string[]) {
    super(`agentdeck-server not found (looked at: ${tried.join(', ')})`);
    this.name = 'ServerBinNotFoundError';
  }
}

/**
 * Which `agentdeck-server` the app drives:
 *   1. `AGENTDECK_SERVER_BIN` (dev, tests, a second install),
 *   2. the bundle shipped inside the app (`resources/server`),
 *   3. unpackaged dev run: `dist-bundle/agentdeck-server` of the checkout.
 */
export async function resolveServerBin(options: {
  env: NodeJS.ProcessEnv;
  /** Electron's `process.resourcesPath`. */
  resourcesPath: string;
  packaged: boolean;
  /** The `desktop/` dir of the checkout (dev runs). */
  desktopDir: string;
  exists: (file: string) => Promise<boolean>;
}): Promise<ResolvedServerBin> {
  const tried: string[] = [];
  const candidates: ResolvedServerBin[] = [];
  if (options.env.AGENTDECK_SERVER_BIN) {
    candidates.push({ bin: path.resolve(options.env.AGENTDECK_SERVER_BIN), source: 'env' });
    // An explicit override never silently falls back to another server.
  } else if (options.packaged) {
    candidates.push({ bin: path.join(options.resourcesPath, 'server', 'bin', 'agentdeck-server'), source: 'bundled' });
  } else {
    candidates.push({
      bin: path.resolve(options.desktopDir, '..', 'dist-bundle', 'agentdeck-server', 'bin', 'agentdeck-server'),
      source: 'dev-bundle',
    });
  }
  for (const candidate of candidates) {
    tried.push(candidate.bin);
    if (await options.exists(candidate.bin)) return candidate;
  }
  throw new ServerBinNotFoundError(tried);
}

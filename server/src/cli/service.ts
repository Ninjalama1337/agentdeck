/**
 * `agentdeck-server service …`: the systemd user unit that runs the server in
 * the background. Everything with side effects is injected (exec, paths,
 * sleep), so the tests drive it against a temp dir and a fake systemctl.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServiceCliStatus } from '@agentdeck/shared';
import { inspectPidFile, pidFilePath, type PidProbe } from '../util/pidfile.js';
import { CliError, type ExecFn } from './exec.js';
import {
  currentRuntimeDir,
  inspectBundle,
  installRuntime,
  launcherPath,
  pruneRuntimes,
  removeRuntime,
  runtimePaths,
  runtimeVersionOf,
  switchCurrent,
  type RuntimePaths,
} from './runtime.js';
import { Systemd, type UnitState } from './systemd.js';
import { DESKTOP_SERVICE_UNIT, parseUnit, renderUnit, type ParsedUnit } from './unit.js';

export interface ServicePaths extends RuntimePaths {
  unitPath: string;
}

export function servicePaths(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): ServicePaths {
  const configHome = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config');
  return {
    ...runtimePaths(env, home),
    unitPath: path.join(configHome, 'systemd', 'user', DESKTOP_SERVICE_UNIT),
  };
}

export interface ServiceContext {
  exec: ExecFn;
  paths: ServicePaths;
  /** Root of the packaged bundle this CLI belongs to; undefined in a checkout. */
  bundleRoot: string | undefined;
  /** Progress messages. */
  report: (message: string) => void;
  /** Data dir of the server: its server.pid tells whether a server runs outside the service. */
  dataDir?: string;
  pidProbe?: PidProbe;
  /** Wait after a start before checking the service stayed up (ms). */
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_SETTLE_MS = 1500;

function readUnit(unitPath: string): string | undefined {
  try {
    return fs.readFileSync(unitPath, 'utf8');
  } catch {
    return undefined;
  }
}

function foreignUnitError(unitPath: string, action: string): CliError {
  return new CliError(
    `${unitPath} exists but was not written by agentdeck-server (it lacks the "# Managed by agentdeck-server" first line — ` +
      `probably the unit of a git checkout). Refusing to ${action} it; pass --force to replace it.`,
  );
}

/** Version of the runtime a unit starts, when it goes through a `…/current/bin/agentdeck-server` path. */
function runtimeVersionFor(unit: ParsedUnit): string | undefined {
  if (!unit.execStart) return undefined;
  const root = path.dirname(path.dirname(path.resolve(unit.execStart))); // …/current or a version directory
  try {
    return runtimeVersionOf(fs.realpathSync(root));
  } catch {
    return undefined; // the link the unit names is gone
  }
}

export async function serviceStatus(ctx: ServiceContext): Promise<ServiceCliStatus> {
  const systemd = new Systemd(ctx.exec);
  const text = readUnit(ctx.paths.unitPath);
  const unit = text !== undefined ? parseUnit(text) : undefined;
  const usable = await systemd.available();
  const state: UnitState = usable && unit ? await systemd.state(DESKTOP_SERVICE_UNIT) : { active: false, enabled: false };
  const runtimeVersion = unit?.managed ? runtimeVersionFor(unit) : undefined;
  return {
    systemd: usable,
    installed: unit !== undefined,
    managed: unit?.managed ?? false,
    enabled: state.enabled,
    active: state.active,
    ...(state.mainPid !== undefined ? { mainPid: state.mainPid } : {}),
    unitPath: ctx.paths.unitPath,
    lan: unit?.lan ?? false,
    ...(runtimeVersion !== undefined ? { runtimeVersion } : {}),
  };
}

async function requireSystemd(ctx: ServiceContext): Promise<Systemd> {
  const systemd = new Systemd(ctx.exec);
  if (!(await systemd.available())) {
    throw new CliError(
      'systemd user services are not available here (`systemctl --user` cannot reach a user manager). ' +
        'Run the server directly with `agentdeck-server` instead.',
    );
  }
  return systemd;
}

/**
 * A server that was started by hand (or by the desktop app, detached) holds the
 * port: a service started next to it would crash and keep restarting. Refuse
 * with a clear message instead.
 */
function assertNoStrayServer(ctx: ServiceContext, state: UnitState): void {
  if (!ctx.dataDir || state.active) return;
  const pid = inspectPidFile(ctx.dataDir, ctx.pidProbe);
  if (pid?.running && pid.pid !== state.mainPid) {
    throw new CliError(
      `An AgentDeck server is already running outside the service (pid ${pid.pid}, see ${pidFilePath(ctx.dataDir)}). ` +
        'It would hold the port the service needs — stop it first (quit it in the desktop app, or `kill ' +
        `${pid.pid}\`), then run this again.`,
    );
  }
}

/** After a start: wait a moment, then make sure the service did not die right away. */
async function ensureStaysUp(ctx: ServiceContext, systemd: Systemd): Promise<void> {
  const settle = ctx.settleMs ?? DEFAULT_SETTLE_MS;
  if (settle > 0) await (ctx.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(settle);
  const state = await systemd.state(DESKTOP_SERVICE_UNIT);
  if (!state.active) {
    throw new CliError(
      `${DESKTOP_SERVICE_UNIT} did not stay up. See: journalctl --user -u ${DESKTOP_SERVICE_UNIT.replace(/\.service$/, '')} -n 40`,
    );
  }
}

export interface InstallOptions {
  /** Bind to all interfaces instead of loopback. */
  lan: boolean;
  /** Fixed port; omitted keeps the port of an earlier install of ours (or the config/default). */
  port?: number;
  /** Enable only; do not start. Default: start (or restart when the unit changed). */
  start?: boolean;
  /** Replace a unit this CLI did not write. */
  force?: boolean;
}

export async function serviceInstall(ctx: ServiceContext, opts: InstallOptions): Promise<ServiceCliStatus> {
  if (!ctx.bundleRoot) {
    throw new CliError(
      'This is not a packaged server, so there is no bundle to install as a service. ' +
        'Install the AgentDeck desktop app (it ships one) — or, for a git checkout, use docs/agentdeck.service (see docs/CONFIG.md).',
    );
  }
  const systemd = await requireSystemd(ctx);
  const existingText = readUnit(ctx.paths.unitPath);
  const existing = existingText !== undefined ? parseUnit(existingText) : undefined;
  if (existing && !existing.managed && !opts.force) throw foreignUnitError(ctx.paths.unitPath, 'overwrite');
  const state = await systemd.state(DESKTOP_SERVICE_UNIT);
  if (opts.start !== false) assertNoStrayServer(ctx, state);

  const bundle = inspectBundle(ctx.bundleRoot);
  const before = currentRuntimeDir(ctx.paths);
  const runtime = installRuntime(bundle, ctx.paths);
  if (runtime.copied) ctx.report(`Copied the server ${bundle.version} to ${runtime.dir}`);
  switchCurrent(ctx.paths, runtime.dir);
  const runtimeChanged = runtime.replaced || before !== fs.realpathSync(runtime.dir);

  const port = opts.port ?? (existing?.managed ? existing.port : undefined);
  const unitText = renderUnit({
    execStart: launcherPath(ctx.paths),
    lan: opts.lan,
    ...(port !== undefined ? { port } : {}),
  });
  const unitChanged = existingText !== unitText;
  if (unitChanged) {
    fs.mkdirSync(path.dirname(ctx.paths.unitPath), { recursive: true });
    const tmp = `${ctx.paths.unitPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, unitText, { mode: 0o644 });
    fs.renameSync(tmp, ctx.paths.unitPath);
    ctx.report(`Wrote ${ctx.paths.unitPath}`);
    await systemd.daemonReload();
  }

  if (opts.start === false) {
    await systemd.enable(DESKTOP_SERVICE_UNIT, false);
    ctx.report('Enabled (not started)');
  } else if (state.active) {
    await systemd.enable(DESKTOP_SERVICE_UNIT, false);
    if (unitChanged || runtimeChanged) {
      await systemd.restart(DESKTOP_SERVICE_UNIT);
      ctx.report('Restarted the service (terminals keep running in tmux)');
      await ensureStaysUp(ctx, systemd);
    } else {
      ctx.report('The service already runs this version');
    }
  } else {
    await systemd.enable(DESKTOP_SERVICE_UNIT, true);
    ctx.report('Enabled and started the service');
    await ensureStaysUp(ctx, systemd);
  }

  const removed = pruneRuntimes(ctx.paths);
  if (removed.length > 0) ctx.report(`Removed old server versions: ${removed.join(', ')}`);
  return serviceStatus(ctx);
}

export async function serviceUninstall(
  ctx: ServiceContext,
  opts: { force?: boolean; runningFrom?: string },
): Promise<ServiceCliStatus> {
  const text = readUnit(ctx.paths.unitPath);
  if (text !== undefined && !parseUnit(text).managed && !opts.force) {
    throw foreignUnitError(ctx.paths.unitPath, 'remove');
  }
  const systemd = new Systemd(ctx.exec);
  const usable = await systemd.available();
  if (text !== undefined) {
    if (usable) {
      await systemd.stop(DESKTOP_SERVICE_UNIT);
      await systemd.disable(DESKTOP_SERVICE_UNIT);
    }
    fs.rmSync(ctx.paths.unitPath, { force: true });
    ctx.report(`Removed ${ctx.paths.unitPath}`);
    if (usable) await systemd.daemonReload();
  } else {
    ctx.report('The service is not installed');
  }
  if (removeRuntime(ctx.paths, opts.runningFrom)) {
    ctx.report(`Removed ${ctx.paths.runtimeRoot} (your data stays untouched)`);
  } else if (fs.existsSync(ctx.paths.runtimeRoot)) {
    ctx.report(`Kept ${ctx.paths.runtimeRoot}: this command runs from it. Delete it by hand when you no longer need it.`);
  }
  return serviceStatus(ctx);
}

export type ServiceControlAction = 'start' | 'stop' | 'restart';

export async function serviceControl(ctx: ServiceContext, action: ServiceControlAction): Promise<ServiceCliStatus> {
  const systemd = await requireSystemd(ctx);
  if (readUnit(ctx.paths.unitPath) === undefined) {
    throw new CliError(
      `${DESKTOP_SERVICE_UNIT} is not installed (${ctx.paths.unitPath}). Run \`agentdeck-server service install\` first.`,
    );
  }
  if (action === 'stop') {
    await systemd.stop(DESKTOP_SERVICE_UNIT);
  } else {
    if (action === 'start') assertNoStrayServer(ctx, await systemd.state(DESKTOP_SERVICE_UNIT));
    await (action === 'start' ? systemd.start(DESKTOP_SERVICE_UNIT) : systemd.restart(DESKTOP_SERVICE_UNIT));
    await ensureStaysUp(ctx, systemd);
  }
  ctx.report(`${action === 'stop' ? 'Stopped' : action === 'start' ? 'Started' : 'Restarted'} ${DESKTOP_SERVICE_UNIT}`);
  return serviceStatus(ctx);
}

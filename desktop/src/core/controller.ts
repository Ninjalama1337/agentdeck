import type { DesktopServiceAction, DesktopSettings, ServerCliInfo, ServiceCliStatus } from './contract';
import type { ServerBinSource, ServerCli } from './cli';
import type { DesktopState } from './settings';
import type { HealthProbe } from './health';
import { originOf, waitForHealth } from './health';
import { buildState, type ServerState } from './serverStatus';
import { runtimeNeedsUpdate } from './versions';

export interface ControllerDeps {
  cli: ServerCli;
  cliSource: ServerBinSource;
  /** Probes `<origin>/api/health`. */
  probe(baseUrl: string): Promise<HealthProbe>;
  detached: {
    isOurs(pidFile: string): Promise<boolean>;
    start(options: { bin: string; env: NodeJS.ProcessEnv }): Promise<number>;
    stop(pidFile: string): Promise<void>;
  };
  settings: { get(): DesktopSettings };
  state: { get(): DesktopState; update(patch: Partial<DesktopState>): Promise<DesktopState> };
  /** Environment for a detached server (already cleaned of Electron / AppImage variables). */
  env: NodeJS.ProcessEnv;
  /** The binary a detached server runs — outside any volatile mount. */
  detachedBin(info: ServerCliInfo): Promise<string>;
  /** Asks whether to set up the background service (first start); true = install. */
  offerService(): Promise<boolean>;
  log(message: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** How long to wait for a server that was just started. */
  startTimeoutMs?: number;
  /** Where the logs are, for error messages. */
  serverLogFile: string;
}

export interface StartFailure {
  ok: false;
  kind: 'port-busy' | 'failed';
  message: string;
  state?: ServerState;
}

export type StartResult = { ok: true; state: ServerState } | StartFailure;

const SERVICE_STATUS_TTL_MS = 10_000;

/**
 * Brings the server up and keeps track of how it runs. All decisions live here,
 * the Electron layer only shows dialogs and windows.
 */
export class ServerController {
  private cachedInfo: ServerCliInfo | null = null;
  private cachedService: { value: ServiceCliStatus | null; at: number } | null = null;
  private current: ServerState | null = null;
  private readonly listeners = new Set<(state: ServerState) => void>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ControllerDeps) {}

  last(): ServerState | null {
    return this.current;
  }

  onChange(listener: (state: ServerState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async info(): Promise<ServerCliInfo> {
    if (!this.cachedInfo) this.cachedInfo = await this.deps.cli.info();
    return this.cachedInfo;
  }

  /** Where the window connects to (the origin is the browser profile — it never changes). */
  async origin(): Promise<string> {
    const info = await this.info();
    return originOf(info.host, info.port);
  }

  /** Current facts about the server. `fresh` skips the short-lived service status cache. */
  async refresh(fresh = false): Promise<ServerState> {
    const info = await this.info();
    const probe = await this.deps.probe(originOf(info.host, info.port));
    const service = await this.serviceStatus(fresh);
    const detachedOurs = probe.state === 'agentdeck' && !service?.active && (await this.deps.detached.isOurs(info.pidFile));
    const state = buildState(info, { probe, service, detachedOurs });
    const changed = JSON.stringify(state) !== JSON.stringify(this.current);
    this.current = state;
    if (changed) for (const listener of this.listeners) listener(state);
    return state;
  }

  private async serviceStatus(fresh: boolean): Promise<ServiceCliStatus | null> {
    const now = this.deps.now();
    if (!fresh && this.cachedService && now - this.cachedService.at < SERVICE_STATUS_TTL_MS) return this.cachedService.value;
    let value: ServiceCliStatus | null = null;
    try {
      value = await this.deps.cli.serviceStatus();
    } catch (err) {
      this.deps.log(`service status unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.cachedService = { value, at: now };
    return value;
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ---------------------------------------------------------------- startup

  /**
   * Makes sure a server answers on the port. `interactive` allows asking the
   * user (service offer); the hidden login start never prompts.
   */
  ensureRunning(options: { interactive: boolean }): Promise<StartResult> {
    return this.exclusive(() => this.doEnsureRunning(options));
  }

  private async doEnsureRunning(options: { interactive: boolean }): Promise<StartResult> {
    let state: ServerState;
    try {
      state = await this.refresh(true);
    } catch (err) {
      return { ok: false, kind: 'failed', message: err instanceof Error ? err.message : String(err) };
    }
    if (state.portConflict) return this.portBusy(state);

    try {
      if (state.reachable) {
        await this.updateRuntimeIfNeeded(state);
        return { ok: true, state: await this.refresh(true) };
      }

      const service = state.service;
      if (service?.systemd && service.installed && service.managed) {
        // Our unit exists: start it — as an update when the app brought a newer server.
        const info = await this.info();
        if (this.runtimeIsOutdated(info, service)) await this.installUnit(service.lan);
        else await this.startUnit();
      } else if (service?.systemd && !service.installed && !this.deps.state.get().serviceDeclined && options.interactive) {
        if (await this.deps.offerService()) {
          await this.installUnit(this.deps.settings.get().lanAccess);
        } else {
          await this.deps.state.update({ serviceDeclined: true });
          await this.startDetached();
        }
      } else {
        await this.startDetached();
      }
      return await this.waitUntilUp();
    } catch (err) {
      return { ok: false, kind: 'failed', message: err instanceof Error ? err.message : String(err) };
    }
  }

  private portBusy(state: ServerState): StartFailure {
    return { ok: false, kind: 'port-busy', message: `Port ${state.port} is used by another program`, state };
  }

  private runtimeIsOutdated(info: ServerCliInfo, service: ServiceCliStatus): boolean {
    return (
      this.deps.cliSource === 'bundled' &&
      service.installed &&
      service.managed &&
      service.runtimeVersion !== undefined &&
      runtimeNeedsUpdate(info.version, service.runtimeVersion)
    );
  }

  /** The app shipped a newer server than the one the service runs: update the service (restarts it). */
  private async updateRuntimeIfNeeded(state: ServerState): Promise<void> {
    const service = state.service;
    const info = await this.info();
    if (!service || !this.runtimeIsOutdated(info, service)) return;
    this.deps.log(`updating the service runtime ${service.runtimeVersion} -> ${info.version}`);
    await this.installUnit(service.lan);
    await this.expectUp();
  }

  /** The CLI refuses install/start while a server outside the unit runs (server.pid) — ours goes first. */
  private async freeServerForService(): Promise<void> {
    const info = await this.info();
    if (await this.deps.detached.isOurs(info.pidFile)) {
      this.deps.log('stopping the detached server before the service takes over');
      await this.stopDetached();
    }
  }

  /** (Re)writes the unit and starts it. The port is always explicit; `--lan` only when wanted (a reinstall does not keep it). */
  private async installUnit(lan: boolean): Promise<void> {
    await this.freeServerForService();
    const info = await this.info();
    await this.deps.cli.serviceInstall({ lan, port: info.port });
  }

  private async startUnit(): Promise<void> {
    await this.freeServerForService();
    await this.deps.cli.serviceStart();
  }

  /** `lan` defaults to the stored setting; a change that is being applied passes its new value (it is stored afterwards). */
  private async startDetached(lan: boolean = this.deps.settings.get().lanAccess): Promise<void> {
    const info = await this.info();
    const bin = await this.deps.detachedBin(info);
    const host = lan ? '0.0.0.0' : '127.0.0.1';
    this.deps.log(`starting the server detached (${bin}, bind ${host})`);
    // Bind address and port are set explicitly: what the app connects to is what the server listens on.
    await this.deps.detached.start({
      bin,
      env: { ...this.deps.env, AGENTDECK_HOST: host, AGENTDECK_PORT: String(info.port) },
    });
  }

  private async waitFor(done: (probe: HealthProbe) => boolean, timeoutMs: number): Promise<boolean> {
    const info = await this.info();
    const base = originOf(info.host, info.port);
    const result = await waitForHealth({
      probe: () => this.deps.probe(base),
      done,
      timeoutMs,
      sleep: (ms) => this.deps.sleep(ms),
      now: () => this.deps.now(),
    });
    return result.ok;
  }

  private async waitUntilUp(): Promise<StartResult> {
    const timeout = this.deps.startTimeoutMs ?? 30_000;
    const up = await this.waitFor((p) => p.state === 'agentdeck', timeout);
    const state = await this.refresh(true);
    if (up && state.reachable) return { ok: true, state };
    if (state.portConflict) return this.portBusy(state);
    const where = state.mode === 'service' ? 'journalctl --user -u agentdeck' : this.deps.serverLogFile;
    return { ok: false, kind: 'failed', message: `The server did not come up within ${Math.round(timeout / 1000)} s (log: ${where})`, state };
  }

  // ---------------------------------------------------------------- actions

  serviceAction(action: DesktopServiceAction): Promise<ServerState> {
    return this.exclusive(async () => {
      const state = await this.refresh(true);
      await this.runAction(action, state);
      return this.refresh(true);
    });
  }

  private async runAction(action: DesktopServiceAction, state: ServerState): Promise<void> {
    const { cli } = this.deps;
    const service = state.service;
    const managed = Boolean(service?.systemd && service.installed && service.managed);
    switch (action) {
      case 'install': {
        if (!service?.systemd) throw new Error('systemd --user is not available on this machine.');
        await this.installUnit(managed && service ? service.lan : this.deps.settings.get().lanAccess);
        await this.expectUp();
        return;
      }
      case 'uninstall': {
        if (!service?.installed) return;
        await cli.serviceUninstall();
        await this.expectDown();
        return;
      }
      case 'start': {
        if (state.reachable) return;
        if (state.portConflict) throw new Error(this.portBusy(state).message);
        if (managed) await this.startUnit();
        else await this.startDetached();
        await this.expectUp();
        return;
      }
      case 'stop': {
        this.requireControllable(state);
        await this.stopRunning(state);
        return;
      }
      case 'restart': {
        if (state.portConflict) throw new Error(this.portBusy(state).message);
        if (state.reachable) this.requireControllable(state);
        if (state.mode === 'service' || (!state.reachable && managed)) {
          if (state.mode === 'service' && service?.active) await cli.serviceRestart();
          else await this.startUnit();
        } else {
          if (state.mode === 'detached') await this.stopDetached();
          await this.startDetached();
        }
        await this.expectUp();
        return;
      }
    }
  }

  private requireControllable(state: ServerState): void {
    if (!state.controllable) throw new Error('This server was not started by AgentDeck — stop it where you started it.');
  }

  private async stopRunning(state: ServerState): Promise<void> {
    if (state.mode === 'service') await this.deps.cli.serviceStop();
    else if (state.mode === 'detached') await this.stopDetached();
    else return;
    await this.expectDown();
  }

  private async stopDetached(): Promise<void> {
    const info = await this.info();
    await this.deps.detached.stop(info.pidFile);
  }

  /** Stops the server on quit — only what the app may stop; an external server is left alone. */
  stopForQuit(): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.refresh(true);
      if (!state.reachable && state.mode !== 'service') return;
      if (state.mode === 'service' || state.mode === 'detached') await this.stopRunning(state);
    });
  }

  /** `--lan` changed: rewrite the unit / restart the detached server with the new bind address. */
  applyLanAccess(lan: boolean): Promise<void> {
    return this.exclusive(async () => {
      const state = await this.refresh(true);
      const service = state.service;
      if (service?.systemd && service.installed && service.managed) {
        if (service.lan === lan) return;
        await this.installUnit(lan);
        if (service.active) await this.deps.cli.serviceRestart();
        await this.expectUp();
      } else if (state.mode === 'detached') {
        await this.stopDetached();
        await this.startDetached(lan);
        await this.expectUp();
      }
      // Tell the window: the binding is part of the status it shows.
      await this.refresh(true);
    });
  }

  private async expectUp(): Promise<void> {
    const result = await this.waitUntilUp();
    if (!result.ok) throw new Error(result.message);
  }

  private async expectDown(): Promise<void> {
    await this.waitFor((p) => p.state !== 'agentdeck', 15_000);
  }
}

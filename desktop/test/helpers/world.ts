import type { ServerCli } from '../../src/core/cli';
import { ServerController } from '../../src/core/controller';
import type { DesktopSettings, ServerCliInfo, ServiceCliStatus } from '../../src/core/contract';
import { DEFAULT_DESKTOP_SETTINGS } from '../../src/core/contract';
import type { HealthProbe } from '../../src/core/health';
import type { DesktopState } from '../../src/core/settings';

export const INFO: ServerCliInfo = {
  version: '2.0.0',
  packaged: true,
  dataDir: '/data',
  configPath: '/cfg',
  host: '127.0.0.1',
  port: 4317,
  pairingCodeFile: '/data/pairing-code.txt',
  pidFile: '/data/server.pid',
};

export const noUnit: ServiceCliStatus = { systemd: true, installed: false, managed: false, enabled: false, active: false, unitPath: '/u', lan: false };

/**
 * A tiny simulated machine: a server that is up or down, an optional systemd
 * unit, an optional detached server. The fake CLI and detached starter mutate
 * it the way the real ones would, and every call is recorded.
 */
export class World {
  probe: HealthProbe = { state: 'closed' };
  service: ServiceCliStatus | null = { ...noUnit };
  /** The running server was started by the app (marker matches). */
  detachedOurs = false;
  calls: string[] = [];
  state: DesktopState = { serviceDeclined: false };
  settings: DesktopSettings = { ...DEFAULT_DESKTOP_SETTINGS };
  offer = true;
  clock = 0;
  info: ServerCliInfo = { ...INFO };
  /** Servers that never come up (to test the timeout). */
  startsFail = false;

  private up(version = this.info.version): void {
    this.probe = this.startsFail ? { state: 'closed' } : { state: 'agentdeck', version };
  }

  cli: ServerCli = {
    bin: '/bundle/bin/agentdeck-server',
    info: async () => this.info,
    serviceStatus: async () => {
      this.calls.push('status');
      if (!this.service) throw new Error('no systemd');
      return { ...this.service };
    },
    serviceInstall: async (options = {}) => {
      this.calls.push(`install${options.lan ? ' --lan' : ''} --port ${options.port}`);
      const wasActive = this.service?.active ?? false;
      this.service = {
        ...(this.service as ServiceCliStatus),
        installed: true,
        managed: true,
        enabled: true,
        active: true,
        lan: Boolean(options.lan),
        runtimeVersion: this.info.version,
      };
      void wasActive;
      this.up();
    },
    serviceUninstall: async () => {
      this.calls.push('uninstall');
      this.service = { ...noUnit };
      this.probe = { state: 'closed' };
    },
    serviceStart: async () => {
      this.calls.push('start');
      this.service = { ...(this.service as ServiceCliStatus), active: true };
      this.up();
    },
    serviceStop: async () => {
      this.calls.push('stop');
      this.service = { ...(this.service as ServiceCliStatus), active: false };
      this.probe = { state: 'closed' };
    },
    serviceRestart: async () => {
      this.calls.push('restart');
      this.up();
    },
  };

  controller = new ServerController({
    cli: this.cli,
    cliSource: 'bundled',
    probe: async () => this.probe,
    detached: {
      isOurs: async () => this.detachedOurs,
      start: async ({ env }) => {
        this.calls.push(`detached-start host=${env.AGENTDECK_HOST} port=${env.AGENTDECK_PORT}`);
        this.detachedOurs = true;
        this.up();
        return 4242;
      },
      stop: async () => {
        this.calls.push('detached-stop');
        this.detachedOurs = false;
        this.probe = { state: 'closed' };
      },
    },
    settings: { get: () => this.settings },
    state: {
      get: () => this.state,
      update: async (patch) => {
        this.state = { ...this.state, ...patch };
        return this.state;
      },
    },
    env: { PATH: '/usr/bin' },
    detachedBin: async () => '/bundle/bin/agentdeck-server',
    offerService: async () => {
      this.calls.push('offer');
      return this.offer;
    },
    log: () => undefined,
    sleep: async (ms) => {
      this.clock += ms;
    },
    now: () => this.clock,
    startTimeoutMs: 3000,
    serverLogFile: '/state/server.log',
  });
}

/**
 * Thin `systemctl --user` wrapper. Everything goes through an injected ExecFn,
 * so the service logic runs in tests without a systemd.
 */
import { CliError, type ExecFn } from './exec.js';

export interface UnitState {
  active: boolean;
  enabled: boolean;
  mainPid?: number;
}

export class Systemd {
  constructor(private readonly exec: ExecFn) {}

  private run(args: string[]) {
    return this.exec('systemctl', ['--user', ...args]);
  }

  /** `systemctl --user` can reach a user manager (not in containers, WSL1, a bare ssh session without one …). */
  async available(): Promise<boolean> {
    const res = await this.run(['show-environment']);
    return res.code === 0;
  }

  async state(unit: string): Promise<UnitState> {
    const res = await this.run(['show', unit, '--property=ActiveState,UnitFileState,MainPID']);
    const props = new Map<string, string>();
    for (const line of res.stdout.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1).trim());
    }
    const active = ['active', 'reloading'].includes(props.get('ActiveState') ?? '');
    const enabled = ['enabled', 'enabled-runtime'].includes(props.get('UnitFileState') ?? '');
    const pid = Number(props.get('MainPID'));
    return { active, enabled, ...(active && Number.isInteger(pid) && pid > 0 ? { mainPid: pid } : {}) };
  }

  private async must(args: string[], what: string): Promise<void> {
    const res = await this.run(args);
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout).trim();
      throw new CliError(`systemctl --user ${args[0]} failed (${what})${detail ? `: ${detail}` : ''}`);
    }
  }

  daemonReload(): Promise<void> {
    return this.must(['daemon-reload'], 'reload the unit files');
  }

  enable(unit: string, now: boolean): Promise<void> {
    return this.must(['enable', ...(now ? ['--now'] : []), unit], `enable ${unit}`);
  }

  /** Not an error when the unit is already gone. */
  async disable(unit: string): Promise<void> {
    await this.run(['disable', unit]);
  }

  start(unit: string): Promise<void> {
    return this.must(['start', unit], `start ${unit}`);
  }

  /** Stopping a unit that is not running (or not loaded) is fine. */
  async stop(unit: string): Promise<void> {
    const res = await this.run(['stop', unit]);
    if (res.code !== 0 && !/not loaded|not found|does not exist/i.test(res.stderr)) {
      throw new CliError(`systemctl --user stop failed (stop ${unit}): ${res.stderr.trim() || `exit ${res.code}`}`);
    }
  }

  restart(unit: string): Promise<void> {
    return this.must(['restart', unit], `restart ${unit}`);
  }
}

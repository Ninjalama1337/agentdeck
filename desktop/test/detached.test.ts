import { describe, expect, it } from 'vitest';
import { DetachedServer, normalizeMarker, readPidFile, type DetachedDeps, type SpawnedChild } from '../src/core/detached';
import { MemFs } from './helpers/memFs';

const PID_FILE = '/data/server.pid';

function setup(options: { alive?: Set<number>; looksLike?: boolean; spawnError?: Error; ignoreTerm?: boolean; initial?: Record<string, string> } = {}) {
  const fs = new MemFs(options.initial);
  const alive = options.alive ?? new Set<number>();
  const events: string[] = [];
  let clock = 0;
  const deps: DetachedDeps = {
    fs,
    markerFile: '/ud/detached.json',
    logFile: '/state/server.log',
    spawn(file, args, opts) {
      events.push(`spawn ${file} [${args.join(' ')}] detached=${opts.detached} stdio=${opts.stdio[0]}/${typeof opts.stdio[1]} host=${opts.env.AGENTDECK_HOST}`);
      const child: SpawnedChild = {
        pid: 777,
        unref: () => events.push('unref'),
        once(event: string, listener: (...a: never[]) => void) {
          if (event === 'spawn' && !options.spawnError) queueMicrotask(() => (listener as () => void)());
          if (event === 'error' && options.spawnError) queueMicrotask(() => (listener as (e: Error) => void)(options.spawnError as Error));
          return child;
        },
      } as SpawnedChild;
      alive.add(777);
      return child;
    },
    openLog: (file) => {
      events.push(`open ${file}`);
      return 9;
    },
    closeFd: (fd) => events.push(`close ${fd}`),
    isAlive: (pid) => alive.has(pid),
    looksLikeServer: async () => options.looksLike ?? true,
    kill(pid, signal) {
      events.push(`kill ${pid} ${signal}`);
      if (signal === 'SIGKILL' || !options.ignoreTerm) alive.delete(pid);
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { server: new DetachedServer(deps), fs, events, alive };
}

describe('pid and marker files', () => {
  it('reads a pid file', async () => {
    expect(await readPidFile(new MemFs({ [PID_FILE]: '123\n' }), PID_FILE)).toBe(123);
    expect(await readPidFile(new MemFs({ [PID_FILE]: 'abc' }), PID_FILE)).toBeNull();
    expect(await readPidFile(new MemFs({ [PID_FILE]: '1' }), PID_FILE)).toBeNull();
    expect(await readPidFile(new MemFs(), PID_FILE)).toBeNull();
  });

  it('validates the marker', () => {
    expect(normalizeMarker({ pid: 5, startedAt: 1, bin: '/b' })).toEqual({ pid: 5, startedAt: 1, bin: '/b' });
    expect(normalizeMarker({ pid: '5' })).toBeNull();
    expect(normalizeMarker(null)).toBeNull();
  });
});

describe('DetachedServer.start', () => {
  it('spawns the CLI detached with the log as stdout/stderr and records the pid', async () => {
    const { server, fs, events } = setup();
    const pid = await server.start({ bin: '/bundle/bin/agentdeck-server', env: { AGENTDECK_HOST: '127.0.0.1' } });
    expect(pid).toBe(777);
    expect(events).toEqual([
      'open /state/server.log',
      'spawn /bundle/bin/agentdeck-server [] detached=true stdio=ignore/number host=127.0.0.1',
      'unref',
      'close 9',
    ]);
    expect(JSON.parse(await fs.readFile('/ud/detached.json'))).toMatchObject({ pid: 777, bin: '/bundle/bin/agentdeck-server' });
  });

  it('rotates a log that grew too big', async () => {
    const { server, fs } = setup({ initial: { '/state/server.log': 'x'.repeat(6 * 1024 * 1024) } });
    await server.start({ bin: '/b', env: {} });
    expect(fs.files.has('/state/server.log.1')).toBe(true);
  });

  it('fails clearly when the program cannot be started, and closes the log', async () => {
    const { server, events, fs } = setup({ spawnError: new Error('spawn EACCES') });
    await expect(server.start({ bin: '/b', env: {} })).rejects.toThrow('EACCES');
    expect(events).toContain('close 9');
    expect(await fs.exists('/ud/detached.json')).toBe(false);
  });
});

describe('DetachedServer.isOurs', () => {
  it('is true only for the pid it started, while alive', async () => {
    const { server, fs, alive } = setup();
    await server.start({ bin: '/b', env: {} });
    expect(await server.isOurs(PID_FILE)).toBe(false); // the server has not written its pid file yet
    await fs.writeFile(PID_FILE, '777\n');
    expect(await server.isOurs(PID_FILE)).toBe(true);
    await fs.writeFile(PID_FILE, '888\n'); // somebody else's server took over
    expect(await server.isOurs(PID_FILE)).toBe(false);
    await fs.writeFile(PID_FILE, '777\n');
    alive.delete(777);
    expect(await server.isOurs(PID_FILE)).toBe(false);
  });

  it('is false without a marker (a checkout started by hand)', async () => {
    const { server } = setup({ initial: { [PID_FILE]: '555\n' } });
    expect(await server.isOurs(PID_FILE)).toBe(false);
  });
});

describe('DetachedServer.stop', () => {
  it('sends SIGTERM and clears the marker once the server is gone', async () => {
    const { server, fs, events } = setup();
    await server.start({ bin: '/b', env: {} });
    await fs.writeFile(PID_FILE, '777\n');
    await server.stop(PID_FILE);
    expect(events.filter((e) => e.startsWith('kill'))).toEqual(['kill 777 SIGTERM']);
    expect(await fs.exists('/ud/detached.json')).toBe(false);
  });

  it('escalates to SIGKILL when the server ignores SIGTERM', async () => {
    const { server, fs, events } = setup({ ignoreTerm: true });
    await server.start({ bin: '/b', env: {} });
    await fs.writeFile(PID_FILE, '777\n');
    await server.stop(PID_FILE, { graceMs: 500 });
    expect(events.filter((e) => e.startsWith('kill'))).toEqual(['kill 777 SIGTERM', 'kill 777 SIGKILL']);
  });

  it('refuses a server that is not ours', async () => {
    const none = setup({ initial: { [PID_FILE]: '555\n' } });
    await expect(none.server.stop(PID_FILE)).rejects.toThrow(/not started by the app/);

    const other = setup();
    await other.server.start({ bin: '/b', env: {} });
    await other.fs.writeFile(PID_FILE, '888\n');
    await expect(other.server.stop(PID_FILE)).rejects.toThrow(/not started by the app/);
    expect(other.events.some((e) => e.startsWith('kill'))).toBe(false);
  });

  it('does not kill a recycled pid that is no AgentDeck process', async () => {
    const { server, fs, events } = setup({ looksLike: false });
    await server.start({ bin: '/b', env: {} });
    await fs.writeFile(PID_FILE, '777\n');
    await server.stop(PID_FILE);
    expect(events.some((e) => e.startsWith('kill'))).toBe(false);
    expect(await fs.exists('/ud/detached.json')).toBe(false);
  });

  it('just clears the marker when the process is already gone', async () => {
    const { server, fs, alive, events } = setup();
    await server.start({ bin: '/b', env: {} });
    await fs.writeFile(PID_FILE, '777\n');
    alive.delete(777);
    await server.stop(PID_FILE);
    expect(events.some((e) => e.startsWith('kill'))).toBe(false);
  });
});

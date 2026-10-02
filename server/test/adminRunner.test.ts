import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentId, AgentInfo } from '@agentdeck/shared';
import type { Broadcaster } from '../src/ws/gateway.js';
import { AdminJobRunner, recipeProcess, type AdminChild, type AdminSpawn } from '../src/admin/runner.js';
import { recipeFor } from '../src/admin/recipes.js';
import type { AgentService } from '../src/agents/registry.js';
import { HttpError } from '../src/http/errors.js';

// ---------------------------------------------------------------------------
// Fake child process + broadcast recorder
// ---------------------------------------------------------------------------

interface FakeHandle {
  child: AdminChild;
  stdout: PassThrough;
  stderr: PassThrough;
  signals: NodeJS.Signals[];
  write(chunk: string, stream?: 'stdout' | 'stderr'): void;
  end(result?: { exitCode?: number; failed?: boolean }): void;
}

function makeHandle(): FakeHandle {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveDone!: (result: { exitCode?: number; failed?: boolean }) => void;
  const done = new Promise<{ exitCode?: number; failed?: boolean }>((resolve) => {
    resolveDone = resolve;
  });
  const signals: NodeJS.Signals[] = [];
  const child: AdminChild = {
    pid: 4242,
    stdout,
    stderr,
    kill: (signal) => {
      signals.push(signal);
    },
    done,
  };
  return {
    child,
    stdout,
    stderr,
    signals,
    write: (chunk, stream = 'stdout') => (stream === 'stdout' ? stdout : stderr).write(chunk),
    end: (result = { exitCode: 0 }) => resolveDone(result),
  };
}

function fakeSpawnFactory(): AdminSpawn & { handles: FakeHandle[] } {
  const handles: FakeHandle[] = [];
  const spawn = (() => {
    const handle = makeHandle();
    handles.push(handle);
    return handle.child;
  }) as AdminSpawn & { handles: FakeHandle[] };
  spawn.handles = handles;
  return spawn;
}

interface RecordedEvent {
  event: string;
  payload: unknown;
}

function broadcastRecorder() {
  const events: RecordedEvent[] = [];
  const fn = ((event: never, ...args: unknown[]) => {
    events.push({ event: event as unknown as string, payload: args[0] });
  }) as unknown as Broadcaster;
  const of = (name: string) => events.filter((e) => e.event === name);
  return { events, fn, of };
}

function fakeAgents() {
  const redetect = vi.fn(async (id: AgentId) => ({ id }) as AgentInfo);
  return { redetect } as unknown as Pick<AgentService, 'redetect'> & { redetect: typeof redetect };
}

const UPDATE_RECIPE = recipeFor('claude', 'update');
const LOGIN_RECIPE = recipeFor('codex', 'login');

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('AdminJobRunner lifecycle', () => {
  it('runs queued → running → done and captures output, exitCode, endedAt', async () => {
    const spawn = fakeSpawnFactory();
    const bus = broadcastRecorder();
    const runner = new AdminJobRunner({ agents: fakeAgents(), log: silentLogger(), broadcast: bus.fn, spawn });

    const job = runner.start('claude', 'update', UPDATE_RECIPE);
    expect(job.status).toBe('queued');
    expect(job.id).toMatch(/^j_/);
    expect(job.startedAt).toBeGreaterThan(0);

    const handle = spawn.handles[0]!;
    handle.write('checking for updates\n');
    handle.write('claude is up to date\n');
    handle.end({ exitCode: 0 });
    await runner.idle();

    const finished = runner.get(job.id)!;
    expect(finished.status).toBe('done');
    expect(finished.exitCode).toBe(0);
    expect(finished.output).toEqual(['checking for updates', 'claude is up to date']);
    expect(finished.endedAt).toBeGreaterThanOrEqual(finished.startedAt);
    expect(finished.error).toBeUndefined();
  });

  it('reports error status for non-zero exits', async () => {
    const spawn = fakeSpawnFactory();
    const runner = new AdminJobRunner({ agents: fakeAgents(), log: silentLogger(), broadcast: bus().fn, spawn });

    const job = runner.start('claude', 'install', recipeFor('claude', 'install'));
    spawn.handles[0]!.write('npm ERR! boom\n', 'stderr');
    spawn.handles[0]!.end({ exitCode: 1, failed: true });
    await runner.idle();

    const finished = runner.get(job.id)!;
    expect(finished.status).toBe('error');
    expect(finished.exitCode).toBe(1);
    expect(finished.error).toContain('exit code 1');
    expect(finished.output).toContain('npm ERR! boom'); // stderr is streamed too
  });

  it('marks spawn failures as errored jobs', async () => {
    const spawn = (() => {
      throw new Error('spawn ENOENT');
    }) as unknown as AdminSpawn;
    const runner = new AdminJobRunner({ agents: fakeAgents(), log: silentLogger(), broadcast: bus().fn, spawn });

    const job = runner.start('codex', 'login', LOGIN_RECIPE);
    await runner.idle();
    expect(runner.get(job.id)!.status).toBe('error');
    expect(runner.get(job.id)!.error).toContain('Failed to spawn');
  });

  it('caps output at a 500-line ring buffer and lines at 2000 chars', async () => {
    const spawn = fakeSpawnFactory();
    const runner = new AdminJobRunner({ agents: fakeAgents(), log: silentLogger(), broadcast: bus().fn, spawn });

    const job = runner.start('claude', 'update', UPDATE_RECIPE);
    const handle = spawn.handles[0]!;
    const lines = Array.from({ length: 600 }, (_, i) => `n${i}`).join('\n') + '\n';
    handle.write(lines);
    handle.write(`${'x'.repeat(3000)}\n`);
    handle.end({ exitCode: 0 });
    await runner.idle();

    const finished = runner.get(job.id)!;
    expect(finished.output).toHaveLength(500);
    // 601 lines total (600 numbered + the oversized one) → the first 101 dropped
    expect(finished.output[0]).toBe('n101');
    expect(finished.output.at(-1)).toHaveLength(2000);
  });

  it('keeps at most 20 jobs, newest first', async () => {
    const spawn = fakeSpawnFactory();
    const runner = new AdminJobRunner({ agents: fakeAgents(), log: silentLogger(), broadcast: bus().fn, spawn });

    const ids: string[] = [];
    for (let i = 0; i < 22; i++) {
      const job = runner.start('claude', 'update', UPDATE_RECIPE);
      spawn.handles.at(-1)!.end({ exitCode: 0 });
      await runner.idle();
      ids.push(job.id);
    }
    const list = runner.list();
    expect(list).toHaveLength(20);
    expect(list[0]!.id).toBe(ids.at(-1));
    expect(list[19]!.id).toBe(ids[2]); // the two oldest were evicted
  });
});

describe('AdminJobRunner one-at-a-time', () => {
  it('rejects a second job with 409 ADMIN_JOB_ACTIVE while one runs', async () => {
    const spawn = fakeSpawnFactory();
    const runner = new AdminJobRunner({ agents: fakeAgents(), log: silentLogger(), broadcast: bus().fn, spawn });

    runner.start('claude', 'update', UPDATE_RECIPE);
    try {
      runner.start('codex', 'login', LOGIN_RECIPE);
      expect.unreachable('second start should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const http = err as HttpError;
      expect(http.statusCode).toBe(409);
      expect(http.code).toBe('ADMIN_JOB_ACTIVE');
    }

    spawn.handles[0]!.end({ exitCode: 0 });
    await runner.idle();
    // done → starting again is allowed
    const second = runner.start('codex', 'login', LOGIN_RECIPE);
    expect(second.status).toBe('queued');
    spawn.handles[1]!.end({ exitCode: 0 });
    await runner.idle();
    expect(runner.get(second.id)!.status).toBe('done');
  });

  it('allows starting again after a failed job (error is not sticky)', async () => {
    const spawn = fakeSpawnFactory();
    const runner = new AdminJobRunner({ agents: fakeAgents(), log: silentLogger(), broadcast: bus().fn, spawn });

    const first = runner.start('claude', 'update', UPDATE_RECIPE);
    spawn.handles[0]!.end({ exitCode: 1, failed: true });
    await runner.idle();
    expect(runner.get(first.id)!.status).toBe('error');

    const second = runner.start('claude', 'update', UPDATE_RECIPE);
    spawn.handles[1]!.end({ exitCode: 0 });
    await runner.idle();
    expect(runner.get(second.id)!.status).toBe('done');
  });
});

describe('AdminJobRunner throttling', () => {
  it('coalesces bursts: ≤ 4 admin:job broadcasts per second, final broadcast on end', async () => {
    vi.useFakeTimers();
    const spawn = fakeSpawnFactory();
    const bus = broadcastRecorder();
    const runner = new AdminJobRunner({ agents: fakeAgents(), log: silentLogger(), broadcast: bus.fn, spawn });

    const job = runner.start('claude', 'update', UPDATE_RECIPE);
    const handle = spawn.handles[0]!;
    for (let i = 0; i < 50; i++) {
      handle.write(`line ${i}\n`); // synchronous burst → must coalesce
    }
    await vi.advanceTimersByTimeAsync(1000); // flush trailing-edge tick
    handle.end({ exitCode: 0 });
    await runner.idle();

    const jobEvents = bus.of('admin:job');
    expect(jobEvents.length).toBeLessThanOrEqual(4);
    expect(jobEvents.length).toBeGreaterThanOrEqual(2); // leading edge + final
    // WS payload shape: { job: AdminJob }
    const final = (jobEvents.at(-1)!.payload as { job: { id: string; status: string; output: string[] } }).job;
    expect(final.id).toBe(job.id);
    expect(final.status).toBe('done');
    expect(final.output).toHaveLength(50); // nothing was lost by throttling
  });
});

describe('AdminJobRunner update/install aftermath', () => {
  it('re-detects the agent and notifies after a successful update', async () => {
    const spawn = fakeSpawnFactory();
    const bus = broadcastRecorder();
    const agents = fakeAgents();
    const runner = new AdminJobRunner({ agents, log: silentLogger(), broadcast: bus.fn, spawn });

    const job = runner.start('claude', 'update', UPDATE_RECIPE);
    spawn.handles[0]!.end({ exitCode: 0 });
    await runner.idle();
    await drainMicrotasks();

    expect(agents.redetect).toHaveBeenCalledWith('claude');
    const notify = bus.of('notify').at(-1)!.payload as { level: string; text: string };
    expect(notify.level).toBe('info');
    expect(notify.text).toBe('Claude Code update finished');
    expect(job.kind).toBe('update');
  });

  it('re-detects even after a failed install (partial changes) with an error notify', async () => {
    const spawn = fakeSpawnFactory();
    const bus = broadcastRecorder();
    const agents = fakeAgents();
    const runner = new AdminJobRunner({ agents, log: silentLogger(), broadcast: bus.fn, spawn });

    runner.start('codex', 'install', recipeFor('codex', 'install'));
    spawn.handles[0]!.end({ exitCode: 1, failed: true });
    await runner.idle();
    await drainMicrotasks();

    expect(agents.redetect).toHaveBeenCalledWith('codex');
    const notify = bus.of('notify').at(-1)!.payload as { level: string; text: string };
    expect(notify.level).toBe('error');
    expect(notify.text).toBe('Codex install finished');
  });

  it('skips re-detection for login jobs', async () => {
    const spawn = fakeSpawnFactory();
    const bus = broadcastRecorder();
    const agents = fakeAgents();
    const runner = new AdminJobRunner({ agents, log: silentLogger(), broadcast: bus.fn, spawn });

    runner.start('codex', 'login', LOGIN_RECIPE);
    spawn.handles[0]!.end({ exitCode: 0 });
    await runner.idle();
    await drainMicrotasks();

    expect(agents.redetect).not.toHaveBeenCalled();
    expect(bus.of('notify')).toHaveLength(0);
  });
});

describe('AdminJobRunner interactive jobs', () => {
  // Without the follow-up: it would edit the real Claude Code config.
  const INTERACTIVE_RECIPE = { ...recipeFor('claude', 'login'), onSuccess: undefined };

  it('reduces terminal output to plain lines and keeps the sign-in URL whole', async () => {
    const spawn = fakeSpawnFactory();
    const runner = new AdminJobRunner({ agents: fakeAgents(), log: silentLogger(), broadcast: bus().fn, spawn });

    const job = runner.start('claude', 'login', INTERACTIVE_RECIPE);
    expect(job.interactive).toBe(true);
    const handle = spawn.handles[0]!;
    handle.write('\x1b[?25l\x1b[38;5;208m✻\x1b[39m\x1b[1COpening\x1b[1Cbrowser\r\n');
    handle.write('\x1b[2K\x1b[1G✶\x1b[1COpening\x1b[1Cbrowser\r\n────────\r\n');
    handle.write('visit:\x1b[1C\x1b[1mhttps://example.test/oauth?code=true&state=a_b-c\x1b[22m\r\n');
    handle.end({ exitCode: 0 });
    await runner.idle();

    expect(runner.get(job.id)!.output).toEqual([
      '✻ Opening browser',
      '✶ Opening browser',
      'visit: https://example.test/oauth?code=true&state=a_b-c',
    ]);
  });

  it('types input into the active job only, followed by Enter', async () => {
    vi.useFakeTimers();
    const spawn = fakeSpawnFactory();
    const runner = new AdminJobRunner({ agents: fakeAgents(), log: silentLogger(), broadcast: bus().fn, spawn });

    const job = runner.start('claude', 'login', INTERACTIVE_RECIPE);
    await vi.advanceTimersByTimeAsync(0);
    const handle = spawn.handles[0]!;
    const typed: string[] = [];
    handle.child.write = (data) => typed.push(data);

    expect(runner.input('j_other', 'code')).toBe(false);
    expect(runner.input(job.id, 'abc#def')).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(typed).toEqual(['abc#def', '\r']);

    handle.end({ exitCode: 0 });
    await vi.runAllTimersAsync();
    await runner.idle();
    expect(runner.input(job.id, 'late')).toBe(false);
  });

  it('presses single keys in the active interactive job only', async () => {
    const spawn = fakeSpawnFactory();
    const runner = new AdminJobRunner({ agents: fakeAgents(), log: silentLogger(), broadcast: bus().fn, spawn });

    const job = runner.start('opencode', 'login', recipeFor('opencode', 'login'));
    await drainMicrotasks();
    const handle = spawn.handles[0]!;
    const typed: string[] = [];
    handle.child.write = (data) => typed.push(data);

    expect(runner.key('j_other', 'down')).toBe(false);
    expect(runner.key(job.id, 'down')).toBe(true);
    expect(runner.key(job.id, 'up')).toBe(true);
    expect(runner.key(job.id, 'enter')).toBe(true);
    expect(typed).toEqual(['\x1b[B', '\x1b[A', '\r']);

    handle.end({ exitCode: 0 });
    await runner.idle();
    expect(runner.key(job.id, 'enter')).toBe(false);
  });

  it('runs the recipe follow-up after a successful exit only', async () => {
    const spawn = fakeSpawnFactory();
    const runner = new AdminJobRunner({ agents: fakeAgents(), log: silentLogger(), broadcast: bus().fn, spawn });
    const onSuccess = vi.fn();

    runner.start('claude', 'login', { ...INTERACTIVE_RECIPE, onSuccess });
    await drainMicrotasks();
    spawn.handles[0]!.end({ exitCode: 1, failed: true });
    await runner.idle();
    expect(onSuccess).not.toHaveBeenCalled();

    const job = runner.start('claude', 'login', { ...INTERACTIVE_RECIPE, onSuccess });
    await drainMicrotasks();
    spawn.handles[1]!.end({ exitCode: 0 });
    await runner.idle();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(runner.get(job.id)!.status).toBe('done');
  });

  it('refuses input for jobs that run without a terminal', async () => {
    const spawn = fakeSpawnFactory();
    const runner = new AdminJobRunner({ agents: fakeAgents(), log: silentLogger(), broadcast: bus().fn, spawn });

    const job = runner.start('claude', 'update', UPDATE_RECIPE);
    await drainMicrotasks();
    expect(job.interactive).toBeUndefined();
    expect(runner.input(job.id, 'code')).toBe(false);
    spawn.handles[0]!.end({ exitCode: 0 });
    await runner.idle();
  });

  it('runs a real command in a pseudo-terminal: prompt shown, typed code read', async () => {
    const runner = new AdminJobRunner({ agents: fakeAgents(), log: silentLogger(), broadcast: bus().fn });
    const script = 'test -t 0 && echo "visit: https://example.test/login" && printf "Paste code > " && read code && echo "got $code"';
    const job = runner.start('claude', 'login', {
      kind: 'login',
      label: 'fake login',
      command: 'sh',
      args: ['-c', script],
      cwd: process.cwd(),
      interactive: true,
    });

    await vi.waitFor(() => expect(runner.get(job.id)!.output).toContain('Paste code >'), { timeout: 5000 });
    expect(runner.input(job.id, 'abc#123')).toBe(true);
    await runner.idle();

    const finished = runner.get(job.id)!;
    expect(finished.status).toBe('done');
    expect(finished.output).toContain('visit: https://example.test/login');
    expect(finished.output).toContain('got abc#123');
  });
});

describe('AdminJobRunner jobs without a terminal', () => {
  it('drops colors from the output so a sign-in link stays clean', async () => {
    const spawn = fakeSpawnFactory();
    const runner = new AdminJobRunner({ agents: fakeAgents(), log: silentLogger(), broadcast: bus().fn, spawn });

    const job = runner.start('codex', 'login', recipeFor('codex', 'login'));
    await drainMicrotasks();
    spawn.handles[0]!.write('   \x1b[94mhttps://auth.example.test/codex/device\x1b[0m\n   \x1b[94mA8RS-QE3DR\x1b[0m\n');
    spawn.handles[0]!.end({ exitCode: 0 });
    await runner.idle();

    expect(runner.get(job.id)!.output).toEqual(['   https://auth.example.test/codex/device', '   A8RS-QE3DR']);
  });

  it('finds commands in the user bin dirs and next to node, not only on the server PATH', async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-admin-'));
    const tool = path.join(home, '.local/bin/agentdeck-fake-tool');
    await fsp.mkdir(path.dirname(tool), { recursive: true });
    await fsp.writeFile(tool, '#!/bin/sh\ncommand -v node >/dev/null && echo "node found"\n', { mode: 0o755 });
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
    const before = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin'; // like the systemd unit: no user dirs
    try {
      const { file, env } = recipeProcess({ kind: 'install', label: 'fake', command: 'agentdeck-fake-tool', args: [], cwd: home });
      expect(file).toBe(tool);
      expect(env.PATH.split(':')).toContain(path.dirname(process.execPath));

      const runner = new AdminJobRunner({ agents: fakeAgents(), log: silentLogger(), broadcast: bus().fn });
      const job = runner.start('codex', 'install', { kind: 'install', label: 'fake', command: 'agentdeck-fake-tool', args: [], cwd: home });
      await runner.idle();
      expect(runner.get(job.id)).toMatchObject({ status: 'done', output: ['node found'] });

      expect(() => recipeProcess({ kind: 'install', label: 'x', command: 'agentdeck-no-such-tool', args: [], cwd: home })).toThrow(
        'agentdeck-no-such-tool not found on PATH',
      );
    } finally {
      process.env.PATH = before;
      homedir.mockRestore();
      await fsp.rm(home, { recursive: true, force: true });
    }
  });
});

describe('AdminJobRunner timeout + stop', () => {
  it('kills the job (SIGTERM → SIGKILL) on timeout and marks it errored', async () => {
    vi.useFakeTimers();
    const spawn = fakeSpawnFactory();
    const runner = new AdminJobRunner({
      agents: fakeAgents(),
      log: silentLogger(),
      broadcast: bus().fn,
      spawn,
      timeoutMs: 50,
    });

    const job = runner.start('claude', 'update', UPDATE_RECIPE);
    const handle = spawn.handles[0]!;
    await vi.advanceTimersByTimeAsync(60);
    expect(handle.signals).toContain('SIGTERM');

    await vi.advanceTimersByTimeAsync(3000); // kill grace elapsed, child still alive
    expect(handle.signals).toContain('SIGKILL');

    handle.end({ exitCode: undefined, failed: true });
    await runner.idle();

    const finished = runner.get(job.id)!;
    expect(finished.status).toBe('error');
    expect(finished.error).toContain('Timed out');
    expect(finished.endedAt).toBeDefined();
  });

  it('stop() SIGTERMs the active job (app close) and settles it as error', async () => {
    const spawn = fakeSpawnFactory();
    const runner = new AdminJobRunner({ agents: fakeAgents(), log: silentLogger(), broadcast: bus().fn, spawn });

    const job = runner.start('zcode', 'update', recipeFor('zcode', 'update'));
    expect(runner.stop('Server shutting down')).toBe(true);
    expect(spawn.handles[0]!.signals).toContain('SIGTERM');

    spawn.handles[0]!.end({ exitCode: undefined, failed: true });
    await runner.idle();
    const finished = runner.get(job.id)!;
    expect(finished.status).toBe('error');
    expect(finished.error).toBe('Server shutting down');
  });

  it('stop() returns false when nothing runs', () => {
    const runner = new AdminJobRunner({ agents: fakeAgents(), log: silentLogger(), broadcast: bus().fn });
    expect(runner.stop()).toBe(false);
  });
});

// ---------------------------------------------------------------------------

function bus(): ReturnType<typeof broadcastRecorder> {
  return broadcastRecorder();
}

function silentLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    fatal: () => undefined,
    child: () => silentLogger(),
  } as never;
}

async function drainMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AdminJob } from '@agentdeck/shared';
import type { DeckIo } from '../src/ws/gateway.js';
import type { AppDeps } from '../src/routes/deps.js';
import type { AdminJobRunner } from '../src/admin/runner.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { signDeviceToken } from '../src/auth/jwt.js';
import { httpError } from '../src/http/errors.js';

let tmp = '';
let app: FastifyInstance;
let io: DeckIo;
let deps: AppDeps;
let jwt: string;

const FAKE_JOB: AdminJob = {
  id: 'j_fake_job_1',
  agentId: 'claude',
  kind: 'update',
  status: 'running',
  output: ['checking…'],
  startedAt: 1_700_000_000_000,
};

const get = (url: string, authed = true) =>
  app.inject({
    method: 'GET',
    url,
    ...(authed ? { headers: { authorization: `Bearer ${jwt}` } } : {}),
  });
const post = (body: unknown, authed = true) =>
  app.inject({
    method: 'POST',
    url: '/api/admin/jobs',
    ...(authed ? { headers: { authorization: `Bearer ${jwt}` } } : {}),
    payload: body,
  });

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-adminroutes-'));
  const config = loadConfig({ env: { AGENTDECK_DATA_DIR: tmp, AGENTDECK_TUNNEL: 'off' }, configDir: path.join(tmp, 'none') });
  const built = await buildApp(config);
  app = built.app;
  io = built.io;
  deps = built.deps;
  jwt = await signDeviceToken(deps.jwtSecret, { deviceId: 'dev_admin_1', name: 'Admin Test' });

  // Route tests use a stubbed runner — the runner itself is covered by
  // adminRunner.test.ts. Route handlers read deps.adminJobs at call time,
  // so swapping the dependency after buildApp is enough.
  const start = vi.fn(() => ({ ...FAKE_JOB }));
  const stub = {
    list: vi.fn(() => [{ ...FAKE_JOB }]),
    start,
    get: vi.fn((id: string) =>
      id === FAKE_JOB.id
        ? { ...FAKE_JOB, status: 'done' }
        : id === 'j_x'
          ? { ...FAKE_JOB, id, status: 'running' }
          : undefined),
    stopJob: vi.fn(() => true),
  } as unknown as AdminJobRunner;
  deps.adminJobs = stub;
});

afterAll(async () => {
  await app.close().catch(() => undefined);
  await fsp.rm(tmp, { recursive: true, force: true });
});

function startMock(): ReturnType<typeof vi.fn> {
  return (deps.adminJobs as unknown as { start: ReturnType<typeof vi.fn> }).start;
}

function stopMock(): ReturnType<typeof vi.fn> {
  return (deps.adminJobs as unknown as { stopJob: ReturnType<typeof vi.fn> }).stopJob;
}

describe('GET /api/admin/jobs', () => {
  it('requires a device token (401 without)', async () => {
    const res = await get('/api/admin/jobs', false);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('lists jobs (newest first, in-memory)', async () => {
    const res = await get('/api/admin/jobs');
    expect(res.statusCode).toBe(200);
    const jobs = res.json() as AdminJob[];
    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs[0]).toMatchObject({ id: 'j_fake_job_1', agentId: 'claude', kind: 'update', status: 'running' });
    expect(Array.isArray(jobs[0]!.output)).toBe(true);
  });

  it('returns a single job by id and 404 for unknown ids', async () => {
    const ok = await get(`/api/admin/jobs/${FAKE_JOB.id}`);
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as AdminJob).status).toBe('done');

    const miss = await get('/api/admin/jobs/j_unknown');
    expect(miss.statusCode).toBe(404);
    expect(miss.json().error.code).toBe('NOT_FOUND');
  });
});

describe('POST /api/admin/jobs', () => {
  it('starts a job and returns 202 with the AdminJob', async () => {
    const res = await post({ agentId: 'claude', kind: 'update' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ id: FAKE_JOB.id, status: 'running' });
    const start = startMock();
    expect(start).toHaveBeenCalledWith('claude', 'update', expect.objectContaining({ command: 'claude', args: ['update'] }));
  });

  it('rejects an unknown kind / agentId with 400', async () => {
    const badKind = await post({ agentId: 'claude', kind: 'reboot' });
    expect(badKind.statusCode).toBe(400);
    expect(badKind.json().error.code).toBe('BAD_REQUEST');

    const badAgent = await post({ agentId: 'gemini', kind: 'update' });
    expect(badAgent.statusCode).toBe(400);
  });

  it('accepts a claude login job (setup-token is available now)', async () => {
    const res = await post({ agentId: 'claude', kind: 'login' });
    expect(res.statusCode).toBe(202);
  });

  it('stop endpoint: 404 unknown, 409 when the job is not active', async () => {
    const notFound = await app.inject({
      method: 'POST',
      url: '/api/admin/jobs/j_none/stop',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(notFound.statusCode).toBe(404);
    stopMock().mockReturnValueOnce(false);
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/admin/jobs/j_x/stop',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { error: { code?: string } }).error.code).toBe('ADMIN_JOB_NOT_ACTIVE');
    stopMock().mockReturnValueOnce(true);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/admin/jobs/j_x/stop',
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(ok.statusCode).toBe(204);
  });

  it('maps the runner conflict to 409 ADMIN_JOB_ACTIVE', async () => {
    startMock().mockImplementationOnce(() => {
      throw httpError(409, 'ADMIN_JOB_ACTIVE', 'An admin job is already running.');
    });
    const res = await post({ agentId: 'codex', kind: 'login' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ADMIN_JOB_ACTIVE');
  });
});

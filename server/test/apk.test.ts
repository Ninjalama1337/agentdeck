import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../src/routes/deps.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { signDeviceToken } from '../src/auth/jwt.js';
import { RateLimiter } from '../src/util/rateLimit.js';

const MAX_APK_BYTES = 64 * 1024;

let tmp = '';
let app: FastifyInstance;
let deps: AppDeps;
let jwt: string;

interface FilePart {
  filename: string;
  content: Buffer;
}

/** Hand-rolled multipart body (keeps the test dependency-free). */
function multipartBody(
  fields: Record<string, string>,
  file: FilePart,
  fileFirst = false,
): { payload: Buffer; contentType: string } {
  const boundary = '----agentdecktest' + crypto.randomBytes(8).toString('hex');
  const fieldPart = (name: string, value: string): Buffer =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      'utf8',
    );
  const fileHead = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="apk"; filename="${file.filename}"\r\n` +
      `Content-Type: application/vnd.android.package-archive\r\n\r\n`,
    'utf8',
  );
  const fileTail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const parts: Buffer[] = [];
  const entries = Object.entries(fields);
  if (fileFirst) {
    parts.push(fileHead, file.content, Buffer.from('\r\n', 'utf8'), ...entries.map(([k, v]) => fieldPart(k, v)));
  } else {
    parts.push(...entries.map(([k, v]) => fieldPart(k, v)), fileHead, file.content, Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    payload: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function upload(
  fields: Record<string, string>,
  file: FilePart,
  headers: Record<string, string> = {},
  fileFirst = false,
) {
  const { payload, contentType } = multipartBody(fields, file, fileFirst);
  return app.inject({
    method: 'POST',
    url: '/api/apk/upload',
    headers: { 'content-type': contentType, ...headers },
    payload,
  });
}

async function tmpCount(dir: string): Promise<number> {
  return (await fsp.readdir(dir)).filter((f) => f.endsWith('.tmp')).length;
}

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-apk-'));
  const config = loadConfig({
    env: {
      AGENTDECK_DATA_DIR: tmp,
      AGENTDECK_MAX_APK_BYTES: String(MAX_APK_BYTES),
    },
    configDir: path.join(tmp, 'none'),
  });
  const built = await buildApp(config);
  app = built.app;
  deps = built.deps;
  jwt = await signDeviceToken(deps.jwtSecret, { deviceId: 'dev_test_1', name: 'Test Device' });
});

afterAll(async () => {
  await app.close().catch(() => undefined);
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('/api/apk', () => {
  it('reports no APK initially and shapes a 404 on download', async () => {
    const info = await app.inject({ method: 'GET', url: '/api/apk/info' });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toEqual({ available: false });
    const latest = await app.inject({ method: 'GET', url: '/api/apk/latest' });
    expect(latest.statusCode).toBe(404);
    expect(latest.json().error.code).toBe('NOT_FOUND');
  });

  it('rejects unauthenticated uploads', async () => {
    const res = await upload({}, { filename: 'agentdeck-1.0.0.apk', content: Buffer.from('x') });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong bridge token', async () => {
    const res = await upload(
      {},
      { filename: 'agentdeck-1.0.0.apk', content: Buffer.from('x') },
      { 'x-bridge-token': 'nope' },
    );
    expect(res.statusCode).toBe(401);
  });

  it('accepts a bridge-token upload with explicit version and stores it atomically', async () => {
    const content = crypto.randomBytes(4096);
    const res = await upload(
      { version: '9.9.9', channel: 'latest' },
      { filename: 'whatever-build.apk', content },
      { 'x-bridge-token': deps.bridgeToken },
    );
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.available).toBe(true);
    expect(body.version).toBe('9.9.9');
    expect(body.channel).toBe('latest');
    expect(body.size).toBe(content.length);
    expect(body.sha256).toBe(crypto.createHash('sha256').update(content).digest('hex'));
    expect(body.fileName).toBe('agentdeck-9.9.9.apk');
    expect(body.message).toContain('9.9.9');
    expect(await tmpCount(deps.apk.dir)).toBe(0);
  });

  it('info reflects the stored APK (public, no auth)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/apk/info' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.available).toBe(true);
    expect(body.version).toBe('9.9.9');
    expect(body.size).toBe(4096);
    expect(typeof body.sha256).toBe('string');
    expect(typeof body.builtAt).toBe('number');
    expect(body.fileName).toBe('agentdeck-9.9.9.apk');
  });

  it('streams the exact bytes with APK download headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/apk/latest' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.android.package-archive');
    expect(res.headers['content-disposition']).toBe('attachment; filename="agentdeck-9.9.9.apk"');
    expect(Number(res.headers['content-length'])).toBe(4096);
    expect(res.rawPayload.length).toBe(4096); // rawPayload is the binary-safe Buffer
  });

  it('falls back to the filename version pattern when no field is given', async () => {
    const content = Buffer.from('fallback-version-bytes');
    // File part FIRST, channel field after — exercises fields-after-file parsing.
    const res = await upload(
      { channel: 'ci' },
      { filename: 'agentdeck-3.1.4.apk', content },
      { 'x-bridge-token': deps.bridgeToken },
      true,
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().version).toBe('3.1.4');
    expect(res.json().channel).toBe('ci');
    expect(res.json().fileName).toBe('agentdeck-3.1.4.apk');
  });

  it('rejects oversized uploads with 413 and leaves no temp files', async () => {
    const res = await upload(
      {},
      { filename: 'agentdeck-huge.apk', content: crypto.randomBytes(MAX_APK_BYTES + 1) },
      { 'x-bridge-token': deps.bridgeToken },
    );
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('APK_TOO_LARGE');
    expect(await tmpCount(deps.apk.dir)).toBe(0);
    // The previously good APK is still intact.
    const info = await app.inject({ method: 'GET', url: '/api/apk/info' });
    expect(info.json().version).toBe('3.1.4');
  });

  it('rejects a multipart body without an apk file', async () => {
    const boundary = '----agentdecktest-empty';
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="version"\r\n\r\n1.0.0\r\n--${boundary}--\r\n`,
      'utf8',
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/apk/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'x-bridge-token': deps.bridgeToken,
      },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });

  it('accepts device-JWT uploads', async () => {
    const content = Buffer.from('jwt-uploaded-bytes');
    const res = await upload(
      { version: '1.2.3' },
      { filename: 'agentdeck-1.2.3.apk', content },
      { authorization: `Bearer ${jwt}` },
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().version).toBe('1.2.3');
    const latest = await app.inject({ method: 'GET', url: '/api/apk/latest' });
    expect(latest.statusCode).toBe(200);
    expect(latest.headers['content-disposition']).toBe('attachment; filename="agentdeck-1.2.3.apk"');
  });
});

describe('RateLimiter (public download budget)', () => {
  it('allows up to max requests per window then blocks', () => {
    let now = 0;
    const limiter = new RateLimiter(3, 60_000, () => now);
    expect(limiter.allow('1.2.3.4')).toBe(true);
    expect(limiter.allow('1.2.3.4')).toBe(true);
    expect(limiter.allow('1.2.3.4')).toBe(true);
    expect(limiter.allow('1.2.3.4')).toBe(false);
    expect(limiter.allow('5.6.7.8')).toBe(true); // independent buckets
    now = 60_001;
    expect(limiter.allow('1.2.3.4')).toBe(true); // window slid
  });
});

describe('/api/health tunnel block', () => {
  it('omits the tunnel field when the provider is off', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().tunnel).toBeUndefined();
  });
});

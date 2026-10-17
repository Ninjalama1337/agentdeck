import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FcmClient } from '../src/notify/fcm.js';
import { NotificationHub, inQuietHours } from '../src/notify/hub.js';

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

async function dataDir(withKey: boolean): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fcm-'));
  if (withKey) {
    await fs.writeFile(
      path.join(dir, 'fcm-service-account.json'),
      JSON.stringify({ project_id: 'demo', client_email: 'sa@demo.iam', private_key: privateKey }),
    );
  }
  return dir;
}

const message = { title: 't', body: 'b', channelId: 'agentdeck-done', high: true, data: { open: 'session:s1' } };

function fetchMock(sendStatus: number) {
  return vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    return new Response('{}', { status: sendStatus });
  }) as unknown as typeof fetch;
}

describe('FcmClient', () => {
  it('is off without a service-account file', async () => {
    expect(await FcmClient.load(path.join(await dataDir(false), 'fcm-service-account.json'))).toBeUndefined();
  });

  it('authenticates once and sends a high-priority message to the channel', async () => {
    const f = fetchMock(200);
    const client = await FcmClient.load(path.join(await dataDir(true), 'fcm-service-account.json'), f);
    expect(await client!.send('device-token', message)).toBe('ok');
    expect(await client!.send('device-token', message)).toBe('ok');
    const calls = vi.mocked(f).mock.calls;
    expect(calls.filter(([u]) => String(u).includes('oauth2'))).toHaveLength(1);
    const sent = calls.find(([u]) => String(u).includes('messages:send'))!;
    const body = JSON.parse(String((sent[1] as RequestInit).body)) as {
      message: { token: string; android: { priority: string; notification: { channel_id: string } } };
    };
    expect(body.message.token).toBe('device-token');
    expect(body.message.android.priority).toBe('HIGH');
    expect(body.message.android.notification.channel_id).toBe('agentdeck-done');
  });

  it('sends a data-only message when the app draws the notification', async () => {
    const f = fetchMock(200);
    const client = await FcmClient.load(path.join(await dataDir(true), 'fcm-service-account.json'), f);
    await client!.send('t', { ...message, dataOnly: true, tag: 'term1', data: { terminalId: 'term1' } });
    const sent = vi.mocked(f).mock.calls.find(([u]) => String(u).includes('messages:send'))!;
    const body = JSON.parse(String((sent[1] as RequestInit).body)) as {
      message: { notification?: unknown; data: Record<string, string>; android: { notification?: unknown } };
    };
    expect(body.message.notification).toBeUndefined();
    expect(body.message.android.notification).toBeUndefined();
    expect(body.message.data).toMatchObject({ terminalId: 'term1', title: 't', body: 'b', channel: 'agentdeck-done', tag: 'term1' });
  });

  it('reports unregistered tokens as dead', async () => {
    const client = await FcmClient.load(path.join(await dataDir(true), 'fcm-service-account.json'), fetchMock(404));
    expect(await client!.send('gone', message)).toBe('dead');
  });
});

describe('NotificationHub FCM tokens', () => {
  it('registers, counts and forgets tokens per device', async () => {
    const hub = new NotificationHub({
      dataDir: await dataDir(false),
      log: { warn() {} } as never,
      broadcast: () => {},
    });
    await hub.init();
    expect(hub.fcmEnabled).toBe(false);
    await hub.registerFcm('d1', 'a'.repeat(30));
    await hub.registerFcm('d1', 'a'.repeat(30));
    await hub.registerFcm('d2', 'b'.repeat(30));
    expect(hub.fcmCount('d1')).toBe(1);
    await hub.forgetDevice('d1');
    expect(hub.fcmCount('d1')).toBe(0);
    expect(hub.fcmCount('d2')).toBe(1);
  });
});

describe('NotificationHub.setFcmKey', () => {
  const key = JSON.stringify({ type: 'service_account', project_id: 'demo', client_email: 'sa@demo.iam', private_key: privateKey });

  it('turns FCM on at once and stores the key privately', async () => {
    const dir = await dataDir(false);
    const hub = new NotificationHub({ dataDir: dir, log: { warn() {} } as never, broadcast: () => {} });
    await hub.init();
    expect(await hub.setFcmKey(key, fetchMock(200))).toEqual({ projectId: 'demo' });
    expect(hub.fcmEnabled).toBe(true);
    const file = path.join(dir, 'fcm-service-account.json');
    expect(await fs.readFile(file, 'utf8')).toBe(key);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('rejects wrong files and keys Google refuses, keeping FCM off', async () => {
    const dir = await dataDir(false);
    const hub = new NotificationHub({ dataDir: dir, log: { warn() {} } as never, broadcast: () => {} });
    await hub.init();
    await expect(hub.setFcmKey('{"project_info":{}}')).rejects.toThrow(/service-account/);
    await expect(hub.setFcmKey(JSON.stringify({ type: 'authorized_user' }))).rejects.toThrow(/authorized_user/);
    await expect(hub.setFcmKey('nope')).rejects.toThrow(/JSON/);
    const refused = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }), { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(hub.setFcmKey(key, refused)).rejects.toThrow(/Invalid JWT Signature/);
    expect(hub.fcmEnabled).toBe(false);
    await expect(fs.access(path.join(dir, 'fcm-service-account.json'))).rejects.toThrow();
  });
});

describe('inQuietHours', () => {
  const at = (h: number, m = 0) => Date.UTC(2026, 0, 1, h, m);

  it('is never quiet without a window', () => {
    expect(inQuietHours(undefined, at(3))).toBe(false);
    expect(inQuietHours({ from: 600, to: 600, tzOffset: 0 }, at(10))).toBe(false);
  });

  it('wraps past midnight in the device time zone', () => {
    // 22:00–07:00 at UTC+2 → 20:00–05:00 UTC
    const q = { from: 22 * 60, to: 7 * 60, tzOffset: 120 };
    expect(inQuietHours(q, at(21))).toBe(true);
    expect(inQuietHours(q, at(4, 59))).toBe(true);
    expect(inQuietHours(q, at(5))).toBe(false);
    expect(inQuietHours(q, at(19, 59))).toBe(false);
  });
});

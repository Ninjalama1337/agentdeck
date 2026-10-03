import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FcmClient } from '../src/notify/fcm.js';
import { NotificationHub } from '../src/notify/hub.js';

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

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

let tmp = '';

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-tunnelcfg-'));
});

afterAll(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('tunnel config', () => {
  it('defaults to provider off / quick mode with the cloudflared binary', () => {
    const config = loadConfig({ env: {}, configDir: path.join(tmp, 'none') });
    expect(config.tunnel).toEqual({
      provider: 'off',
      mode: 'quick',
      token: '',
      name: '',
      credentialsFile: '',
      hostname: '',
      binary: 'cloudflared',
    });
  });

  it('defaults maxApkBytes to 200 MB', () => {
    const config = loadConfig({ env: {}, configDir: path.join(tmp, 'none') });
    expect(config.maxApkBytes).toBe(200 * 1024 * 1024);
  });

  it('AGENTDECK_TUNNEL=cloudflared enables the provider', () => {
    const config = loadConfig({
      env: { AGENTDECK_TUNNEL: 'cloudflared' },
      configDir: path.join(tmp, 'none'),
    });
    expect(config.tunnel.provider).toBe('cloudflared');
    expect(config.tunnel.mode).toBe('quick');
  });

  it('AGENTDECK_TUNNEL=off disables it', () => {
    const config = loadConfig({
      env: { AGENTDECK_TUNNEL: 'off' },
      configDir: path.join(tmp, 'none'),
    });
    expect(config.tunnel.provider).toBe('off');
  });

  it('AGENTDECK_TUNNEL_TOKEN sets the token and implies token mode', () => {
    const config = loadConfig({
      env: { AGENTDECK_TUNNEL: 'cloudflared', AGENTDECK_TUNNEL_TOKEN: 'secret-token' },
      configDir: path.join(tmp, 'none'),
    });
    expect(config.tunnel.token).toBe('secret-token');
    expect(config.tunnel.mode).toBe('token');
  });

  it('AGENTDECK_TUNNEL_BINARY overrides the binary', () => {
    const config = loadConfig({
      env: { AGENTDECK_TUNNEL_BINARY: '/opt/cf/bin/cloudflared' },
      configDir: path.join(tmp, 'none'),
    });
    expect(config.tunnel.binary).toBe('/opt/cf/bin/cloudflared');
  });

  it('file config wins over nothing and env wins over file', () => {
    const configDir = path.join(tmp, 'cfg');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ tunnel: { provider: 'cloudflared', hostname: 'deck.example.com' } }),
    );
    const fromFile = loadConfig({ env: {}, configDir });
    expect(fromFile.tunnel.provider).toBe('cloudflared');
    expect(fromFile.tunnel.hostname).toBe('deck.example.com');
    expect(fromFile.tunnel.mode).toBe('quick'); // untouched default

    const withEnv = loadConfig({ env: { AGENTDECK_TUNNEL: 'off' }, configDir });
    expect(withEnv.tunnel.provider).toBe('off');
    expect(withEnv.tunnel.hostname).toBe('deck.example.com'); // merge keeps other keys
  });

  it('rejects token mode without a token (env provider + file mode)', () => {
    const modeDir = path.join(tmp, 'tokmode');
    fs.mkdirSync(modeDir, { recursive: true });
    fs.writeFileSync(path.join(modeDir, 'config.json'), JSON.stringify({ tunnel: { mode: 'token' } }));
    expect(() =>
      loadConfig({ env: { AGENTDECK_TUNNEL: 'cloudflared' }, configDir: modeDir }),
    ).toThrow(/token/i);
  });

  it('rejects a file-configured token mode without token', () => {
    const badDir = path.join(tmp, 'bad');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(
      path.join(badDir, 'config.json'),
      JSON.stringify({ tunnel: { provider: 'cloudflared', mode: 'token' } }),
    );
    expect(() => loadConfig({ env: {}, configDir: badDir })).toThrow(/token/i);
  });

  it('rejects named mode without a tunnel name', () => {
    const namedDir = path.join(tmp, 'namedmode');
    fs.mkdirSync(namedDir, { recursive: true });
    fs.writeFileSync(
      path.join(namedDir, 'config.json'),
      JSON.stringify({ tunnel: { provider: 'cloudflared', mode: 'named' } }),
    );
    expect(() => loadConfig({ env: {}, configDir: namedDir })).toThrow(/name/i);
  });

  it('accepts named mode with name + hostname', () => {
    const namedDir = path.join(tmp, 'namedok');
    fs.mkdirSync(namedDir, { recursive: true });
    fs.writeFileSync(
      path.join(namedDir, 'config.json'),
      JSON.stringify({
        tunnel: { provider: 'cloudflared', mode: 'named', name: 'agentdeck', hostname: 'deck.example.com' },
      }),
    );
    const cfg = loadConfig({ env: {}, configDir: namedDir });
    expect(cfg.tunnel.mode).toBe('named');
    expect(cfg.tunnel.name).toBe('agentdeck');
    expect(cfg.tunnel.hostname).toBe('deck.example.com');
  });

  it('mode token with the provider off is accepted (tunnel simply stays disabled)', () => {
    const offDir = path.join(tmp, 'offmode');
    fs.mkdirSync(offDir, { recursive: true });
    fs.writeFileSync(
      path.join(offDir, 'config.json'),
      JSON.stringify({ tunnel: { mode: 'token' } }),
    );
    const config = loadConfig({ env: {}, configDir: offDir });
    expect(config.tunnel.provider).toBe('off');
    expect(config.tunnel.mode).toBe('token');
  });
});

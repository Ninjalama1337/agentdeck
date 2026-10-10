import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateSecret, PairingCodeManager } from '../src/auth/secrets.js';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-secrets-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const mode = (file: string): number => fs.statSync(file).mode & 0o777;

describe('secret file permissions', () => {
  it('the pairing code is created 0600', async () => {
    const code = await new PairingCodeManager(dir).readOrCreate();
    expect(code).toMatch(/^\d{6}$/);
    expect(mode(path.join(dir, 'pairing-code.txt'))).toBe(0o600);
  });

  it('a pairing code file that is too open is tightened on startup', async () => {
    const file = path.join(dir, 'pairing-code.txt');
    fs.writeFileSync(file, '123456\n', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    expect(await new PairingCodeManager(dir).readOrCreate()).toBe('123456');
    expect(mode(file)).toBe(0o600);
  });

  it('rotating keeps it 0600, also over an open file', async () => {
    const file = path.join(dir, 'pairing-code.txt');
    fs.writeFileSync(file, '123456\n');
    fs.chmodSync(file, 0o666);
    const manager = new PairingCodeManager(dir);
    const next = await manager.rotate();
    expect(await manager.read()).toBe(next);
    expect(mode(file)).toBe(0o600);
  });

  it('jwt-secret and bridge-token are tightened too', async () => {
    const file = path.join(dir, 'bridge-token');
    fs.writeFileSync(file, 'a'.repeat(64));
    fs.chmodSync(file, 0o644);
    expect(await loadOrCreateSecret(dir, 'bridge-token')).toBe('a'.repeat(64));
    expect(mode(file)).toBe(0o600);
    await loadOrCreateSecret(dir, 'jwt-secret');
    expect(mode(path.join(dir, 'jwt-secret'))).toBe(0o600);
  });
});

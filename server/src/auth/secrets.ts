import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../util/atomicWrite.js';
import { ensureDir } from '../util/paths.js';

function randomHex(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Loads `name` from dataDir or creates it with fresh random hex content.
 * Files are written with 0600 permissions (jwt-secret, bridge-token).
 */
export async function loadOrCreateSecret(dataDir: string, name: string): Promise<string> {
  await ensureDir(dataDir);
  const file = path.join(dataDir, name);
  try {
    const existing = (await fsp.readFile(file, 'utf8')).trim();
    if (existing.length >= 32) {
      // Files from before the mode was set (or restored from a backup) are tightened too.
      await fsp.chmod(file, 0o600).catch(() => undefined);
      return existing;
    }
  } catch {
    // fall through to creation
  }
  const secret = randomHex(32);
  await writeFileAtomic(file, secret, 0o600);
  return secret;
}

/** Reads the bridge token written at startup (used by bridge-authenticated routes). */
export async function readBridgeToken(dataDir: string): Promise<string | undefined> {
  try {
    const token = (await fsp.readFile(path.join(dataDir, 'bridge-token'), 'utf8')).trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/** 6-digit pairing code stored at dataDir/pairing-code.txt. */
export class PairingCodeManager {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'pairing-code.txt');
  }

  static generate(): string {
    // Uniform 6-digit code, zero-padded (000000-999999).
    return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  async read(): Promise<string | undefined> {
    try {
      const code = (await fsp.readFile(this.file, 'utf8')).trim();
      return /^\d{6}$/.test(code) ? code : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Returns the stored code or creates a fresh one (first startup). The file is
   * (re)set to 0600 — the desktop app reads the code from it, nobody else may.
   */
  async readOrCreate(): Promise<string> {
    const existing = await this.read();
    if (existing) {
      await fsp.chmod(this.file, 0o600).catch(() => undefined);
      return existing;
    }
    return this.rotate();
  }

  async rotate(): Promise<string> {
    const code = PairingCodeManager.generate();
    await ensureDir(path.dirname(this.file));
    // Atomic: the desktop shell reads this file while a pairing rotates it.
    await writeFileAtomic(this.file, code + '\n', 0o600);
    return code;
  }
}

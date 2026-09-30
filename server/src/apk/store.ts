/**
 * APK distribution storage: dataDir/apk/agentdeck-latest.apk + apk.json
 * {version, size, sha256, builtAt, channel}.
 *
 * Uploads stream to a temp file inside the apk dir (sha256 computed while
 * writing, size capped), then move atomically onto agentdeck-latest.apk.
 * Staging and committing are separate phases because multipart text fields
 * (version, channel) may arrive before OR after the file part.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { ApkInfo } from '@agentdeck/shared';
import { ensureDir } from '../util/paths.js';

/** Thrown when an upload exceeds maxApkBytes; the route maps it to 413. */
export class ApkTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`APK exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB limit.`);
    this.name = 'ApkTooLargeError';
  }
}

export interface ApkMetadata {
  version: string;
  size: number;
  sha256: string;
  builtAt: number;
  channel: string;
}

/** Strips filename-hostile characters from a user-supplied version string. */
export function sanitizeVersion(raw: string): string {
  const cleaned = raw
    // eslint-disable-next no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/["/\\]/g, '_')
    .trim();
  const safe = cleaned.length > 0 ? cleaned : 'unknown';
  return safe.length > 100 ? safe.slice(0, 100) : safe;
}

/** `agentdeck-<version>.apk` → `<version>`, else undefined. */
export function versionFromFilename(filename: string): string | undefined {
  const match = /^agentdeck-(.+)\.apk$/i.exec(path.basename(filename ?? ''));
  return match?.[1] || undefined;
}

/**
 * Upload version resolution per contract: explicit field wins, then the
 * `agentdeck-<version>.apk` filename pattern, then the file mtime (ISO date).
 */
export function resolveVersion(explicit: string | undefined, filename: string, mtime: Date): string {
  const trimmed = explicit?.trim();
  if (trimmed) return sanitizeVersion(trimmed);
  return sanitizeVersion(versionFromFilename(filename) ?? mtime.toISOString());
}

export interface StagedApk {
  tmpPath: string;
  /** Original upload filename (used for the version fallback pattern). */
  filename: string;
  size: number;
  sha256: string;
  mtime: Date;
}

export interface CommitOptions {
  explicitVersion?: string;
  channel?: string;
}

export class ApkStore {
  readonly dir: string;
  readonly filePath: string;
  private readonly metaFile: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'apk');
    this.filePath = path.join(this.dir, 'agentdeck-latest.apk');
    this.metaFile = path.join(this.dir, 'apk.json');
  }

  async init(): Promise<void> {
    await ensureDir(this.dir);
  }

  /** Current APK metadata; `{available:false}` when nothing was uploaded. */
  async info(): Promise<ApkInfo> {
    const meta = await this.readMeta();
    if (!meta) return { available: false };
    let size = meta.size;
    try {
      size = (await fsp.stat(this.filePath)).size;
    } catch {
      return { available: false };
    }
    return {
      available: true,
      version: meta.version,
      size,
      sha256: meta.sha256,
      builtAt: meta.builtAt,
      channel: meta.channel,
      fileName: `agentdeck-${meta.version}.apk`,
    };
  }

  /**
   * Phase 1: streams the upload into a temp file inside the apk dir, hashing
   * on the way and enforcing maxBytes. Cleans up after itself on failure.
   */
  async stageFromStream(stream: Readable, opts: { maxBytes: number; filename: string }): Promise<StagedApk> {
    await ensureDir(this.dir);
    const tmpPath = path.join(this.dir, `.upload-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    let truncated = false;
    stream.on('limit', () => {
      truncated = true;
    });
    try {
      await pipeline(
        stream,
        async function* (source) {
          for await (const chunk of source as AsyncIterable<Buffer>) {
            size += chunk.length;
            if (size > opts.maxBytes) {
              truncated = true;
              throw new ApkTooLargeError(opts.maxBytes);
            }
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(tmpPath),
      );
    } catch (err) {
      await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
      if (err instanceof ApkTooLargeError) throw err;
      // A busboy 'limit' truncation surfaces as a stream error — map to 413.
      if (truncated) throw new ApkTooLargeError(opts.maxBytes);
      throw err;
    }
    if (truncated) {
      await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
      throw new ApkTooLargeError(opts.maxBytes);
    }
    const mtime = (await fsp.stat(tmpPath)).mtime;
    return { tmpPath, filename: opts.filename, size, sha256: hash.digest('hex'), mtime };
  }

  /**
   * Phase 2: resolves the version (explicit field → filename → mtime), moves
   * the staged file atomically onto agentdeck-latest.apk and writes apk.json.
   */
  async commitStaged(staged: StagedApk, opts: CommitOptions = {}): Promise<ApkMetadata & { fileName: string }> {
    try {
      const meta: ApkMetadata = {
        version: resolveVersion(opts.explicitVersion, staged.filename, staged.mtime),
        size: staged.size,
        sha256: staged.sha256,
        builtAt: Date.now(),
        channel: opts.channel?.trim() || 'latest',
      };
      await fsp.rename(staged.tmpPath, this.filePath); // atomic move within the same dir
      await this.writeMeta(meta);
      return { ...meta, fileName: `agentdeck-${meta.version}.apk` };
    } catch (err) {
      await fsp.rm(staged.tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  private async readMeta(): Promise<ApkMetadata | undefined> {
    try {
      const raw = await fsp.readFile(this.metaFile, 'utf8');
      const parsed = JSON.parse(raw) as ApkMetadata;
      if (parsed && typeof parsed.version === 'string' && typeof parsed.sha256 === 'string') {
        return parsed;
      }
    } catch {
      // Missing/corrupt metadata → treat as no APK.
    }
    return undefined;
  }

  private async writeMeta(meta: ApkMetadata): Promise<void> {
    const tmp = `${this.metaFile}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf8');
    await fsp.rename(tmp, this.metaFile);
  }
}

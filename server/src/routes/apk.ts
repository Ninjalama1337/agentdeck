/**
 * APK distribution routes (per CONTRACT):
 * - GET  /api/apk/info   — public metadata (no auth)
 * - GET  /api/apk/latest — public binary download (no auth, 30/min per IP)
 * - POST /api/apk/upload — device JWT or x-bridge-token (localhost) upload
 *
 * These routes are exact-path only so they can never shadow the SPA fallback
 * or /api/projects/:id/files.
 */
import fsp from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Multipart } from '@fastify/multipart';
import { ApkTooLargeError, type StagedApk } from '../apk/store.js';
import { httpError, notFound } from '../http/errors.js';
import { clientIp } from '../util/ip.js';
import type { AppDeps } from './deps.js';

const APK_MIME = 'application/vnd.android.package-archive';

export async function apkRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/apk/info', async () => deps.apk.info());

  fastify.get('/apk/latest', async (req, reply) => {
    if (!deps.apkLimiter.allow(clientIp(req))) {
      throw httpError(429, 'TOO_MANY_REQUESTS', 'Too many APK downloads — try again in a minute.');
    }
    const info = await deps.apk.info();
    if (!info.available || !info.fileName) throw notFound('No APK has been uploaded yet.');
    let size: number;
    try {
      size = (await fsp.stat(deps.apk.filePath)).size;
    } catch {
      throw notFound('No APK has been uploaded yet.');
    }
    reply.type(APK_MIME);
    reply.header('content-length', size);
    reply.header('content-disposition', `attachment; filename="${info.fileName.replace(/"/g, '')}"`);
    // Same send-chain pattern as the file download route (async handler).
    return reply.send(createReadStream(deps.apk.filePath));
  });

  fastify.post('/apk/upload', { preHandler: deps.apkUploadGuard }, async (req, reply) => {
    // Route-scoped busboy limits: overrides the 20 MB attachment default.
    const limits = {
      files: 1,
      fields: 16,
      fileSize: deps.config.maxApkBytes,
    } as const;

    const fields: Record<string, string> = {};
    let staged: StagedApk | undefined;
    try {
      for await (const part of req.parts({ limits }) as AsyncIterableIterator<Multipart>) {
        if (part.type === 'file') {
          // Consume immediately: multipart parsing stalls (backpressure) until
          // the file stream is read, and later fields must still be parsed.
          if (!staged) {
            staged = await deps.apk.stageFromStream(part.file, {
              maxBytes: deps.config.maxApkBytes,
              filename: part.filename,
            });
          }
          // Extra file parts: files:1 makes busboy raise a limit error itself.
        } else if (typeof part.value === 'string') {
          fields[part.fieldname] = part.value;
        }
      }
    } catch (err) {
      // Busboy raises FST_REQ_FILE_TOO_LARGE (413) on the iterator after
      // truncating an over-limit file; stageFromStream maps its own path.
      if (err instanceof ApkTooLargeError || (err as { statusCode?: number }).statusCode === 413) {
        await fsp.rm(staged?.tmpPath ?? '', { force: true }).catch(() => undefined);
        throw httpError(413, 'APK_TOO_LARGE', err instanceof ApkTooLargeError ? err.message : `APK exceeds the ${Math.round(deps.config.maxApkBytes / (1024 * 1024))} MB limit.`);
      }
      await fsp.rm(staged?.tmpPath ?? '', { force: true }).catch(() => undefined);
      throw httpError(400, 'BAD_REQUEST', `Malformed multipart upload: ${(err as Error).message}`);
    }
    if (!staged) throw httpError(400, 'BAD_REQUEST', 'Multipart field "apk" is required.');

    let meta;
    try {
      meta = await deps.apk.commitStaged(staged, {
        ...(fields.version !== undefined ? { explicitVersion: fields.version } : {}),
        ...(fields.channel !== undefined ? { channel: fields.channel } : {}),
      });
    } catch (err) {
      throw httpError(500, 'APK_STORE_FAILED', `Failed to store APK: ${(err as Error).message}`);
    }

    deps.log.info({ version: meta.version, size: meta.size }, 'APK uploaded');
    deps.broadcast('notify', { level: 'info', text: `APK ${meta.version} uploaded` });
    reply.code(201).send({
      available: true,
      version: meta.version,
      size: meta.size,
      sha256: meta.sha256,
      builtAt: meta.builtAt,
      channel: meta.channel,
      fileName: meta.fileName,
      message: `APK ${meta.version} uploaded.`,
    });
  });
}

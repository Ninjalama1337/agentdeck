import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Attachment, FileDownloadUrlResponse } from '@agentdeck/shared';
import { z } from 'zod';
import { notFound, httpError } from '../http/errors.js';
import { assertNotGitPath, resolveInsideRoot } from '../files/sandbox.js';
import { EDIT_TEMP_PREFIX } from '../files/watcher.js';
import { guessMime, isInlineMime, listDirectory } from '../files/browser.js';
import { fileIndex } from '../files/fileIndex.js';
import { sanitizeFileName } from '../util/paths.js';
import { newFileId } from '../util/ids.js';
import { signDownloadToken, verifyDownloadToken } from '../auth/downloadTokens.js';
import { getProjectOr404 } from './projects.js';
import { ATTACHMENTS_PROJECT_ID, signedFileUrl } from './attachments.js';
import type { AppDeps } from './deps.js';

function uploadTarget(deps: AppDeps, projectId: string): { root: string; tokenProjectId: string } {
  if (projectId === ATTACHMENTS_PROJECT_ID) {
    return { root: deps.store.attachmentsRoot, tokenProjectId: ATTACHMENTS_PROJECT_ID };
  }
  const project = getProjectOr404(deps, projectId);
  return { root: project.path, tokenProjectId: project.id };
}

export async function fileRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/projects/:id/files', async (req) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    const query = z
      .object({ path: z.string().default(''), all: z.string().optional() })
      .parse(req.query ?? {});
    const resolved = await resolveInsideRoot(project.path, query.path, { create: true });
    // Any file access lazily arms the project's live watcher.
    deps.fileWatchers.ensureStarted(project.id, project.path);
    return listDirectory(resolved.abs, resolved.rel, { all: query.all === '1' });
  });

  // Every file path of the project (quick open searches it on the device).
  fastify.get('/projects/:id/files/index', async (req) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    return fileIndex(project.path);
  });

  fastify.get('/projects/:id/files/raw', async (req, reply) => {
    const projectId = (req.params as { id: string }).id;
    const query = z
      .object({ path: z.string().min(1), token: z.string().optional(), download: z.string().optional() })
      .parse(req.query ?? {});
    const { root } = uploadTarget(deps, projectId);

    // Auth: signed token (download managers) or a valid device bearer token.
    if (query.token) {
      const payload = verifyDownloadToken(deps.jwtSecret, query.token, {
        projectId,
        path: query.path,
      });
      if (!payload) throw httpError(401, 'UNAUTHORIZED', 'Invalid or expired download token.');
    } else if (!req.device) {
      throw httpError(401, 'UNAUTHORIZED', 'Unauthorized');
    }

    const resolved = await resolveInsideRoot(root, query.path);
    let stats;
    try {
      stats = await fsp.stat(resolved.abs);
    } catch {
      throw notFound('File not found');
    }
    if (stats.isDirectory()) throw httpError(400, 'IS_DIRECTORY', 'Path is a directory');

    const mime = guessMime(resolved.abs);
    const filename = path.basename(resolved.abs);
    // `download=1` forces a save even for images/text (explicit "Download" tap).
    const disposition = isInlineMime(mime) && query.download !== '1' ? 'inline' : 'attachment';
    reply.type(mime);
    reply.header('content-length', stats.size);
    reply.header('content-disposition', `${disposition}; filename="${filename.replace(/"/g, '')}"`);
    // Return the send chain: in async handlers a plain `reply.send(...)` followed
    // by an implicit `undefined` return would override the stream with "".
    return reply.send(createReadStream(resolved.abs));
  });

  // Signed, header-free URL for one file. The Android app hands it to the
  // system browser / download manager, which cannot send the bearer token.
  fastify.get('/projects/:id/files/download-url', async (req) => {
    const projectId = (req.params as { id: string }).id;
    const query = z.object({ path: z.string().min(1) }).parse(req.query ?? {});
    const { root, tokenProjectId } = uploadTarget(deps, projectId);
    const resolved = await resolveInsideRoot(root, query.path);
    let stats;
    try {
      stats = await fsp.stat(resolved.abs);
    } catch {
      throw notFound('File not found');
    }
    if (stats.isDirectory()) throw httpError(400, 'IS_DIRECTORY', 'Path is a directory');
    // Sign the path exactly as requested: /files/raw verifies against its own `path` query.
    const token = signDownloadToken(deps.jwtSecret, { projectId: tokenProjectId, path: query.path });
    const url = `/api/projects/${encodeURIComponent(tokenProjectId)}/files/raw?path=${encodeURIComponent(query.path)}&token=${token}&download=1`;
    return { url } satisfies FileDownloadUrlResponse;
  });

  fastify.post('/projects/:id/files/upload', async (req, reply) => {
    const projectId = (req.params as { id: string }).id;
    const query = z
      .object({
        sessionId: z.string().optional(),
        terminalId: z.string().optional(),
        dir: z.string().optional(),
        // Project uploads only: save under exactly this name (no id prefix).
        name: z.string().min(1).max(255).optional(),
        overwrite: z.string().optional(),
      })
      .parse(req.query ?? {});
    const project = getProjectOr404(deps, projectId);

    const file = await req.file();
    if (!file) throw httpError(400, 'BAD_REQUEST', 'Multipart field "file" is required.');

    // Decide the destination: session attachments dir wins, else project dir.
    let destDir: string;
    let signRoot: string;
    let tokenProjectId: string;
    if (query.sessionId) {
      const session = deps.store.getSession(query.sessionId);
      if (!session) throw notFound('Session not found');
      destDir = deps.store.attachmentsDirFor(session.id);
      signRoot = deps.store.attachmentsRoot;
      tokenProjectId = ATTACHMENTS_PROJECT_ID;
    } else if (query.terminalId) {
      // A file handed to the agent in a terminal: kept out of the project, the
      // agent gets its absolute path typed into the prompt.
      const term = deps.terminals.get(query.terminalId);
      if (!term) throw notFound('Terminal not found');
      destDir = deps.store.attachmentsDirFor(`terminal-${term.info.id}`);
      signRoot = deps.store.attachmentsRoot;
      tokenProjectId = ATTACHMENTS_PROJECT_ID;
    } else {
      const dir = query.dir ?? '';
      const resolved = await resolveInsideRoot(project.path, dir, { create: true });
      destDir = resolved.abs;
      signRoot = project.path;
      tokenProjectId = project.id;
    }
    await fsp.mkdir(destDir, { recursive: true });

    const fileId = newFileId();
    const exactName = query.name !== undefined && !query.sessionId && !query.terminalId;
    // A terminal gets the path typed in: nothing in the name a shell or a TUI would split at.
    const safeName = query.terminalId
      ? sanitizeFileName(file.filename).replace(/[^A-Za-z0-9._-]+/g, '_')
      : sanitizeFileName(exactName ? (query.name ?? file.filename) : file.filename);
    const dest = path.join(destDir, exactName ? safeName : `${fileId}__${safeName}`);
    if (!dest.startsWith(destDir + path.sep)) {
      throw httpError(400, 'BAD_REQUEST', 'Invalid filename.');
    }
    // A chosen name may collide: refuse, or replace only on request — and
    // write next to it first, so a failed upload leaves the old file intact.
    let tmpDir: string | null = null;
    if (exactName) {
      try {
        assertNotGitPath(path.relative(signRoot, dest).split(path.sep).join('/'));
        const existing = await fsp.lstat(dest).catch(() => undefined);
        if (existing?.isDirectory()) throw httpError(409, 'EXISTS', 'A folder with this name already exists.');
        if (existing && query.overwrite !== '1') {
          throw httpError(409, 'EXISTS', 'A file with this name already exists.');
        }
      } catch (err) {
        file.file.resume();
        throw err;
      }
      tmpDir = await fsp.mkdtemp(path.join(destDir, EDIT_TEMP_PREFIX));
    }
    const writeTo = tmpDir ? path.join(tmpDir, 'file') : dest;

    let tooLarge = false;
    file.file.on('limit', () => {
      tooLarge = true;
    });
    const cleanup = async (): Promise<void> => {
      await fsp.rm(tmpDir ?? dest, { recursive: true, force: true }).catch(() => undefined);
    };
    try {
      await pipeline(file.file, createWriteStream(writeTo));
    } catch (err) {
      await cleanup();
      throw err;
    }
    if (tooLarge) {
      await cleanup();
      throw httpError(
        413,
        'FILE_TOO_LARGE',
        `Attachment exceeds the ${Math.round(deps.config.maxUploadBytes / (1024 * 1024))} MB limit.`,
      );
    }

    if (tmpDir) {
      try {
        await fsp.rename(writeTo, dest);
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    const stats = await fsp.stat(dest);
    const mime = file.mimetype || guessMime(dest);

    const attachment: Attachment = {
      id: fileId,
      name: safeName,
      mime,
      size: stats.size,
      url: signedFileUrl(deps.jwtSecret, tokenProjectId, signRoot, dest),
      kind: mime.startsWith('image/') ? 'image' : 'file',
      ...(query.terminalId ? { path: dest } : {}),
    };
    reply.code(201).send(attachment);
  });
}

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Attachment, ChatMessage, Project, Session, SessionDetailResponse, ThinkingEffort } from '@agentdeck/shared';
import { z } from 'zod';
import { execa } from 'execa';
import { httpError, notFound } from '../http/errors.js';
import { guessMime } from '../files/browser.js';
import { resolveInsideRoot } from '../files/sandbox.js';
import { signedFileUrl } from './attachments.js';
import { ATTACHMENTS_PROJECT_ID } from './attachments.js';
import { getProjectOr404 } from './projects.js';
import { newMessageId } from '../util/ids.js';
import { sleep } from '../util/async.js';
import { parseEffortInput, validEffortsText } from '../agents/effort.js';
import type { RunAttachment } from '../agents/types.js';
import type { AppDeps } from './deps.js';

function getSessionOr404(deps: AppDeps, id: string): Session {
  const session = deps.store.getSession(id);
  if (!session) throw notFound('Session not found');
  return session;
}

/** Validated effort from raw input; blank/undefined → inherit (undefined). */
export function effortOr400(value: string | undefined): ThinkingEffort | undefined {
  const parsed = parseEffortInput(value);
  if (!parsed.ok) {
    throw httpError(
      400,
      'INVALID_EFFORT',
      `Invalid thinkingEffort "${parsed.value}". Valid values: ${validEffortsText()}.`,
    );
  }
  return parsed.effort;
}

const CreateSessionSchema = z.object({
  projectId: z.string().min(1),
  agentId: z.enum(['claude', 'zcode', 'antigravity', 'codex']),
  model: z.string().optional(),
  thinkingEffort: z.string().optional(),
  permissionMode: z.enum(['default', 'acceptEdits', 'plan', 'bypass']).optional(),
  /** Account profile (env overrides) — must belong to this agent. */
  accountId: z.string().optional(),
  title: z.string().max(120).optional(),
});

const UpdateSessionSchema = z.object({
  permissionMode: z.enum(['default', 'acceptEdits', 'plan', 'bypass']).optional(),
});

const SendTurnSchema = z.object({
  text: z.string().min(1).max(200_000),
  attachmentIds: z.array(z.string().min(1)).max(10).optional(),
  model: z.string().optional(),
  thinkingEffort: z.string().optional(),
});

const AnswerPermissionSchema = z.object({
  decision: z.enum(['allow', 'always', 'deny']),
  message: z.string().max(2000).optional(),
  answers: z.record(z.string().max(2000)).optional(),
});

/** Builds the client-facing Attachment DTO with a signed download URL. */
async function attachmentDto(
  deps: AppDeps,
  session: Session,
  project: Project,
  absPath: string,
  fileId: string,
): Promise<Attachment> {
  const stats = await fsp.stat(absPath);
  const name = path.basename(absPath).replace(/^[a-z0-9]+__/, '');
  const inAttachments = absPath.startsWith(deps.store.attachmentsRoot + path.sep);
  const projectId = inAttachments ? ATTACHMENTS_PROJECT_ID : project.id;
  const root = inAttachments ? deps.store.attachmentsRoot : project.path;
  const mime = guessMime(absPath);
  return {
    id: fileId,
    name,
    mime,
    size: stats.size,
    url: signedFileUrl(deps.jwtSecret, projectId, root, absPath),
    kind: mime.startsWith('image/') ? 'image' : 'file',
  };
}

export async function sessionRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/sessions', async (req) => {
    const query = z.object({ projectId: z.string().optional() }).parse(req.query ?? {});
    return deps.store.listSessions(query.projectId);
  });

  fastify.post('/sessions', async (req, reply) => {
    const body = CreateSessionSchema.parse(req.body);
    getProjectOr404(deps, body.projectId);
    const thinkingEffort = effortOr400(body.thinkingEffort);
    if (body.accountId) {
      const account = deps.store.getAccount(body.accountId);
      if (!account || account.agentId !== body.agentId) {
        throw httpError(400, 'BAD_REQUEST', 'Unknown account for this agent.');
      }
    }
    // No account chosen: the agent's active one (Settings / usage switcher).
    const accountId = body.accountId ?? deps.activeAccounts.get(body.agentId)?.id;
    const session = await deps.store.newSession({
      projectId: body.projectId,
      agentId: body.agentId,
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
      ...(body.permissionMode !== undefined ? { permissionMode: body.permissionMode } : {}),
      ...(accountId !== undefined ? { accountId } : {}),
      ...(body.title !== undefined ? { title: body.title } : {}),
    });
    reply.code(201).send(session);
  });

  fastify.get('/sessions/:id', async (req) => {
    const session = getSessionOr404(deps, (req.params as { id: string }).id);
    const { after } = z.object({ after: z.string().optional() }).parse(req.query ?? {});
    const all = await deps.store.getMessages(session.id);
    // `after`: a client that already holds the history asks only for what is new.
    const known = after ? all.findIndex((m) => m.id === after) : -1;
    const draft = deps.manager.draftOf(session.id) ?? null;
    return {
      session,
      messages: known >= 0 ? all.slice(known + 1) : all,
      draft,
      ...(known >= 0 ? { partial: true } : {}),
    } satisfies SessionDetailResponse;
  });

  fastify.patch('/sessions/:id', async (req) => {
    const session = getSessionOr404(deps, (req.params as { id: string }).id);
    const body = UpdateSessionSchema.parse(req.body);
    if (body.permissionMode !== undefined) session.permissionMode = body.permissionMode;
    return deps.store.saveSession(session);
  });

  fastify.delete('/sessions/:id', async (req, reply) => {
    const session = getSessionOr404(deps, (req.params as { id: string }).id);
    if (deps.manager.isActive(session.id)) {
      deps.manager.interrupt(session.id, 'Session deleted');
    }
    await deps.store.deleteSession(session.id);
    deps.broadcast('notify', { level: 'info', text: `Session "${session.title}" deleted.` });
    reply.code(204).send();
  });

  fastify.post('/sessions/:id/messages', async (req, reply) => {
    const session = getSessionOr404(deps, (req.params as { id: string }).id);
    const project = getProjectOr404(deps, session.projectId);
    const body = SendTurnSchema.parse(req.body);

    const gate = deps.manager.canStart(session);
    if (!gate.ok) throw httpError(409, gate.code, gate.message);

    // Resolve attachments (uploaded earlier via the upload endpoint).
    const runs: RunAttachment[] = [];
    const dtos: Attachment[] = [];
    for (const fileId of body.attachmentIds ?? []) {
      const found = await deps.store.findAttachment(session, project, fileId);
      if (!found) throw httpError(400, 'BAD_REQUEST', `Unknown attachment: ${fileId}`);
      const dto = await attachmentDto(deps, session, project, found.absPath, fileId);
      dto.name = found.name || dto.name;
      dtos.push(dto);
      runs.push({ path: found.absPath, name: dto.name, mime: dto.mime, size: dto.size });
    }

    // Title from the first user message.
    if (session.title === 'New session' && body.text.trim()) {
      session.title = body.text.trim().slice(0, 60);
    }

    // An explicit effort overrides the turn AND becomes the new session
    // default (persisted below → session:update broadcast).
    const thinkingEffort = effortOr400(body.thinkingEffort);
    if (thinkingEffort !== undefined) session.thinkingEffort = thinkingEffort;

    const userMessage: ChatMessage = {
      id: newMessageId(),
      sessionId: session.id,
      role: 'user',
      agentId: session.agentId,
      text: body.text,
      attachments: dtos,
      ts: Date.now(),
      source: 'app',
    };
    await deps.store.appendMessage(userMessage);
    await deps.store.saveSession(session);

    // Fire and forget: completion flows through session:update / session:event.
    void deps.manager
      .startTurn({
        session,
        project,
        text: body.text,
        attachments: runs,
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
        source: 'app',
      })
      .catch((err) => deps.log.error({ err, session: session.id }, 'startTurn crashed'));

    reply.send({ userMessage });
  });

  fastify.post('/sessions/:id/permissions/:requestId', async (req, reply) => {
    const { id, requestId } = req.params as { id: string; requestId: string };
    const session = getSessionOr404(deps, id);
    const body = AnswerPermissionSchema.parse(req.body);
    const answered = await deps.manager.answerPermission(session.id, requestId, body);
    if (!answered) throw httpError(409, 'PERMISSION_GONE', 'That question is no longer open.');
    reply.code(204).send();
  });

  fastify.post('/sessions/:id/interrupt', async (req, reply) => {
    const session = getSessionOr404(deps, (req.params as { id: string }).id);
    deps.manager.interrupt(session.id, 'Interrupted from app');
    reply.code(204).send();
  });

  fastify.post('/sessions/:id/ide', async (req, reply) => {
    const session = getSessionOr404(deps, (req.params as { id: string }).id);
    const project = getProjectOr404(deps, session.projectId);
    const adapter = deps.agents.get(session.agentId);
    const ide = adapter?.ideCommand?.(project.path);
    if (!ide) {
      throw httpError(
        409,
        'IDE_UNSUPPORTED',
        `${deps.agents.infoOf(session.agentId)?.label ?? session.agentId} does not support IDE launch.`,
      );
    }
    const child = execa(ide.command, ide.args, {
      detached: true,
      stdio: 'ignore',
      reject: false,
      cleanup: false,
      unref: true,
    });
    const result = await Promise.race([
      child.then((r) => ({ exited: true as const, code: r.exitCode })),
      sleep(1500).then(() => ({ exited: false as const })),
    ]);
    if (result.exited && result.code !== 0) {
      throw httpError(500, 'IDE_LAUNCH_FAILED', `Failed to launch IDE (exit code ${result.code}).`);
    }
    reply.code(204).send();
  });
}

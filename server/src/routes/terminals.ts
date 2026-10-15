/**
 * Terminal REST surface ("Code" tab). Streaming happens over WS events —
 * these routes only create/list/kill PTYs and hand back replayable output.
 */
import type { FastifyInstance } from 'fastify';
import fsp from 'node:fs/promises';
import { z } from 'zod';
import { httpError, notFound } from '../http/errors.js';
import { getProjectOr404 } from './projects.js';
import type { AppDeps } from './deps.js';
import { listPresets, resolveLaunch } from '../term/presets.js';
import type { TerminalBroadcasts } from '../term/manager.js';
import { stateTitle } from '../notify/hub.js';

const CreateSchema = z.object({
  projectId: z.string().min(1),
  cols: z.number().int().min(10).max(500).optional(),
  rows: z.number().int().min(4).max(300).optional(),
  presetId: z.string().max(40).optional(),
  variantId: z.string().max(40).optional(),
  command: z.string().max(1000).optional(),
  title: z.string().max(80).optional(),
  timeZone: z.string().max(64).optional(),
});

/** A zone name this machine knows — it ends up in the terminal's environment. */
export function knownTimeZone(zone: string | undefined): string | undefined {
  if (!zone || !/^[A-Za-z0-9_+\-/]+$/.test(zone)) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** Body when the screen offers nothing more specific. */
const ATTENTION_TEXT = {
  done: 'Finished — tap to see the result.',
  waiting: 'Stopped to ask you something — tap to answer.',
  limit: 'No usage left — it continues once the limit resets.',
  error: 'Stopped with an error — tap to look.',
} as const;

export function terminalBroadcasts(deps: AppDeps): TerminalBroadcasts {
  return {
    onData: (id: string, data: string) => deps.broadcast('terminal:data', { id, data }),
    onExit: (id: string, code: number) => deps.broadcast('terminal:exit', { id, code }),
    onList: () => deps.broadcast('terminal:list', { terminals: deps.terminals.list() }),
    onAttention: (info, reason, { state, detail, prompt }) => {
      deps.broadcast('terminal:attention', { id: info.id, reason, state, ...(detail ? { text: detail } : {}) });
      const project = deps.store.getProject(info.projectId);
      deps.notifications.notify({
        kind: 'terminal-attention',
        state,
        title: stateTitle(state, info.title ?? 'Terminal', project?.name ?? 'terminal'),
        body: detail ?? ATTENTION_TEXT[state],
        projectId: info.projectId,
        terminalId: info.id,
        ...(prompt ? { prompt } : {}),
      });
    },
  };
}

export async function terminalRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  /** Files uploaded for a terminal (routes/files.ts) go with it. */
  const dropUploads = (id: string) =>
    void fsp.rm(deps.store.attachmentsDirFor(`terminal-${id}`), { recursive: true, force: true }).catch(() => undefined);

  fastify.get('/terminals', async (req) => {
    const query = z.object({ projectId: z.string().optional() }).parse(req.query ?? {});
    return deps.terminals.list(query.projectId);
  });

  fastify.get('/terminals/presets', async (req) => {
    const query = z.object({ refresh: z.string().optional() }).parse(req.query ?? {});
    return listPresets(query.refresh === '1');
  });

  fastify.get('/terminals/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const term = deps.terminals.get(id);
    if (!term) throw notFound('Terminal not found');
    return { terminal: term.info, replay: deps.terminals.replayOf(id) ?? '' };
  });

  fastify.post('/terminals', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const project = getProjectOr404(deps, body.projectId);
    let launch: ReturnType<typeof resolveLaunch>;
    try {
      launch = resolveLaunch(body.presetId, body.variantId, body.command);
    } catch (err) {
      throw httpError(400, 'BAD_PRESET', err instanceof Error ? err.message : String(err));
    }
    const timeZone = knownTimeZone(body.timeZone);
    const info = deps.terminals.spawn(
      project.path,
      project.id,
      body.cols ?? 80,
      body.rows ?? 24,
      terminalBroadcasts(deps),
      {
        title: body.title?.trim() || launch.title,
        presetId: launch.presetId,
        ...(launch.variantId ? { variantId: launch.variantId } : {}),
        idleNotify: launch.agent,
        ...(launch.command ? { command: launch.command } : {}),
        ...(timeZone ? { timeZone } : {}),
      },
    );
    reply.code(201).send({ terminal: info });
  });

  fastify.delete('/terminals/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ok = deps.terminals.kill(id, terminalBroadcasts(deps));
    if (!ok) throw notFound('Terminal not found');
    dropUploads(id);
    reply.code(204).send();
  });

  fastify.post('/terminals/:id/kill', async (req, reply) => {
    // Same as DELETE — kept for the UI's explicit "end" action.
    const id = (req.params as { id: string }).id;
    if (deps.terminals.kill(id, terminalBroadcasts(deps))) dropUploads(id);
    reply.code(204).send();
  });

  // Yes/no from a notification button. Never blind: the screen is read again
  // and the key is only sent while it still shows the very prompt the button
  // was made for.
  fastify.post('/terminals/:id/answer', async (req) => {
    const id = (req.params as { id: string }).id;
    const body = z.object({ answer: z.enum(['yes', 'no']), prompt: z.enum(['menu', 'yesno']) }).parse(req.body);
    const verdict = await deps.terminals.currentVerdict(id);
    if (!verdict) throw httpError(409, 'TERMINAL_GONE', 'Terminal has exited.');
    if (verdict.state !== 'waiting' || verdict.prompt !== body.prompt) {
      throw httpError(409, 'PROMPT_GONE', 'The terminal is no longer asking that question.');
    }
    const keys = body.prompt === 'menu' ? (body.answer === 'yes' ? '\r' : '\x1b') : body.answer === 'yes' ? 'y\r' : 'n\r';
    if (!deps.terminals.write(id, keys)) throw httpError(409, 'TERMINAL_GONE', 'Terminal has exited.');
    return { ok: true };
  });

  // Claude Code hooks of a terminal (same machine, bridge token). The empty
  // answer leaves every decision with Claude and the user.
  fastify.post(
    '/bridge/terminal-hook/:id',
    { preHandler: deps.bridgeGuard, bodyLimit: 16 * 1024 * 1024 },
    async (req) => {
      deps.terminals.hookEvent((req.params as { id: string }).id, req.body, terminalBroadcasts(deps));
      return {};
    },
  );

  // Input/resize go over the WS gateway; a REST fallback exists for the MCP
  // bridge and simple scripting.
  fastify.post('/terminals/:id/input', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = z.object({ data: z.string().max(4096) }).parse(req.body);
    if (!deps.terminals.write(id, body.data)) throw httpError(409, 'TERMINAL_GONE', 'Terminal has exited.');
    reply.code(204).send();
  });
}

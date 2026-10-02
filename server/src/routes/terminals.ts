/**
 * Terminal REST surface ("Code" tab). Streaming happens over WS events —
 * these routes only create/list/kill PTYs and hand back replayable output.
 */
import type { FastifyInstance } from 'fastify';
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
});

/** Body when the screen offers nothing more specific. */
const ATTENTION_TEXT = {
  done: 'Finished — tap to see the result.',
  waiting: 'Stopped to ask you something — tap to answer.',
  limit: 'No usage left — it continues once the limit resets.',
} as const;

export function terminalBroadcasts(deps: AppDeps): TerminalBroadcasts {
  return {
    onData: (id: string, data: string) => deps.broadcast('terminal:data', { id, data }),
    onExit: (id: string, code: number) => deps.broadcast('terminal:exit', { id, code }),
    onList: () => deps.broadcast('terminal:list', { terminals: deps.terminals.list() }),
    onAttention: (info, reason, { state, detail }) => {
      deps.broadcast('terminal:attention', { id: info.id, reason, state, ...(detail ? { text: detail } : {}) });
      const project = deps.store.getProject(info.projectId);
      deps.notifications.notify({
        kind: 'terminal-attention',
        state,
        title: stateTitle(state, info.title ?? 'Terminal', project?.name ?? 'terminal'),
        body: detail ?? ATTENTION_TEXT[state],
        projectId: info.projectId,
        terminalId: info.id,
      });
    },
  };
}

export async function terminalRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
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
      },
    );
    reply.code(201).send({ terminal: info });
  });

  fastify.delete('/terminals/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ok = deps.terminals.kill(id, terminalBroadcasts(deps));
    if (!ok) throw notFound('Terminal not found');
    reply.code(204).send();
  });

  fastify.post('/terminals/:id/kill', async (req, reply) => {
    // Same as DELETE — kept for the UI's explicit "end" action.
    const id = (req.params as { id: string }).id;
    deps.terminals.kill(id, terminalBroadcasts(deps));
    reply.code(204).send();
  });

  // Input/resize go over the WS gateway; a REST fallback exists for the MCP
  // bridge and simple scripting.
  fastify.post('/terminals/:id/input', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = z.object({ data: z.string().max(4096) }).parse(req.body);
    if (!deps.terminals.write(id, body.data)) throw httpError(409, 'TERMINAL_GONE', 'Terminal has exited.');
    reply.code(204).send();
  });
}

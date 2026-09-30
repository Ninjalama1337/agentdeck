/**
 * Terminal REST surface ("Code" tab). Streaming happens over WS events —
 * these routes only create/list/kill PTYs and hand back replayable output.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { httpError, notFound } from '../http/errors.js';
import { getProjectOr404 } from './projects.js';
import type { AppDeps } from './deps.js';

const CreateSchema = z.object({
  projectId: z.string().min(1),
  cols: z.number().int().min(10).max(500).optional(),
  rows: z.number().int().min(4).max(300).optional(),
});

export function terminalBroadcasts(deps: AppDeps) {
  return {
    onData: (id: string, data: string) => deps.broadcast('terminal:data', { id, data }),
    onExit: (id: string, code: number) => deps.broadcast('terminal:exit', { id, code }),
    onList: () => deps.broadcast('terminal:list', { terminals: deps.terminals.list() }),
  };
}

export async function terminalRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/terminals', async (req) => {
    const query = z.object({ projectId: z.string().optional() }).parse(req.query ?? {});
    return deps.terminals.list(query.projectId);
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
    const info = deps.terminals.spawn(
      project.path,
      project.id,
      body.cols ?? 80,
      body.rows ?? 24,
      terminalBroadcasts(deps),
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

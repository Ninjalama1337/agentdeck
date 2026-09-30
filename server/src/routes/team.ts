import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../http/errors.js';
import { getProjectOr404 } from './projects.js';
import type { AppDeps } from './deps.js';

const TeamRunSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().max(120).optional(),
  mode: z.enum(['sequence', 'parallel']),
  passContext: z.boolean().optional(),
  steps: z
    .array(
      z.object({
        agentId: z.enum(['claude', 'zcode', 'antigravity', 'codex']),
        prompt: z.string().min(1).max(100_000),
      }),
    )
    .min(1)
    .max(10),
});

export async function teamRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/team/runs', async (req) => {
    const query = z.object({ projectId: z.string().optional() }).parse(req.query ?? {});
    return deps.store.listTeams(query.projectId);
  });

  fastify.post('/team/runs', async (req, reply) => {
    const body = TeamRunSchema.parse(req.body);
    getProjectOr404(deps, body.projectId);
    const run = await deps.teams.create(body);
    reply.code(202).send(run);
  });

  fastify.get('/team/runs/:id', async (req) => {
    const run = deps.store.getTeam((req.params as { id: string }).id);
    if (!run) throw notFound('Team run not found');
    return run;
  });

  fastify.post('/team/runs/:id/stop', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const stopped = await deps.teams.stop(id);
    if (!stopped) throw notFound('Team run not found');
    reply.code(204).send();
  });
}

/**
 * Activity: what the agents did, from the server's database (stats/db.ts).
 *
 * GET /api/stats       — sums per agent, model, project, source and day
 * GET /api/stats/runs  — the single runs, newest first
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from './deps.js';

const DAY_MS = 24 * 60 * 60_000;

const SummaryQuery = z.object({
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  /** Minutes the device's clock is ahead of UTC. */
  tzOffset: z.coerce.number().int().min(-840).max(840).optional(),
});

const RunsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.coerce.number().int().nonnegative().optional(),
  agentId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  routineId: z.string().min(1).optional(),
});

export async function statsRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/stats', async (req) => {
    const query = SummaryQuery.parse(req.query ?? {});
    const to = query.to ?? Date.now() + 1;
    return deps.stats.summary({ from: query.from ?? to - 30 * DAY_MS, to, tzOffset: query.tzOffset ?? 0 });
  });

  fastify.get('/stats/runs', async (req) => deps.stats.runs(RunsQuery.parse(req.query ?? {})));
}

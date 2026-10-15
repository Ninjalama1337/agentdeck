import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildDailySummary } from '../stats/digest.js';
import type { AppDeps } from './deps.js';

/** Today's summary (in the device's timezone) and the evening digest's settings. */
export async function digestRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/digest/today', async (req) => {
    const q = z.object({ tzOffset: z.coerce.number().int().min(-840).max(840).optional() }).parse(req.query ?? {});
    return buildDailySummary(deps.stats, deps.store.listProjects(), Date.now(), q.tzOffset);
  });

  fastify.get('/digest', async () => deps.digest.get());

  fastify.put('/digest', async (req) => {
    const body = z
      .object({ enabled: z.boolean().optional(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional() })
      .parse(req.body);
    return deps.digest.set(body);
  });
}

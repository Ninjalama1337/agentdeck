import type { FastifyInstance } from 'fastify';
import type { AppDeps } from './deps.js';

/**
 * GET /api/usage — per-agent subscription usage (authed via the global device
 * hook). Server-side cached 30 s inside the collector; concurrent calls share
 * one collection run.
 */
export async function usageRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/usage', async () => {
    const usages = await deps.usage.collect();
    // Each reading goes on record, so the app can show how a subscription was used over time.
    deps.stats.recordPlans(usages);
    return usages;
  });
}

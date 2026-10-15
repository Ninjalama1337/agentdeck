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
    // On record (the app shows how a subscription was used over time) and checked against the warning levels.
    deps.usageWatcher.observe(usages);
    return usages;
  });
}

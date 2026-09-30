import type { FastifyInstance } from 'fastify';
import type { AppDeps } from './deps.js';

/**
 * GET /api/usage — per-agent subscription usage (authed via the global device
 * hook). Server-side cached ≥60 s inside the collector; concurrent calls share
 * one collection run.
 */
export async function usageRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/usage', async () => deps.usage.collect());
}

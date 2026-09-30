import type { FastifyInstance } from 'fastify';
import type { AppDeps } from './deps.js';

/** GET /api/tunnel — current tunnel status (authed via the global device hook). */
export async function tunnelRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/tunnel', async () => deps.tunnel.getInfo());
}

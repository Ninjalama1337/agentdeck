import type { FastifyInstance } from 'fastify';
import type { AppDeps } from './deps.js';

/**
 * Server self-update (CONTRACT.md): which version runs here, what the latest
 * GitHub release is, and a one-call update to it. Authed via the global
 * device hook; progress streams via the WS `update:state` event.
 */
export async function updateRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/update', async (req) => {
    const refresh = (req.query as { refresh?: string }).refresh;
    return deps.update.info(refresh === '1' || refresh === 'true');
  });

  fastify.post('/update', async (_req, reply) => {
    // Throws 409 (running / nothing to do / not a git checkout) or 502 (check failed).
    const info = await deps.update.start();
    deps.log.info({ target: info.job?.target }, 'server update started');
    reply.code(202).send(info);
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from './deps.js';

/** Keep the server machine awake while agents work (power/keepAwake.ts). */
export async function powerRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/power', async () => deps.keepAwake.status());

  fastify.put('/power', async (req) => {
    const body = z.object({ keepAwake: z.boolean() }).parse(req.body);
    return deps.keepAwake.setEnabled(body.keepAwake);
  });
}

import type { FastifyInstance } from 'fastify';
import { notFound } from '../http/errors.js';
import type { AppDeps } from './deps.js';

export async function deviceRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/devices', async () => deps.store.listDevices());

  fastify.delete('/devices/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const deleted = await deps.store.deleteDevice(id);
    if (!deleted) throw notFound('Device not found');
    await deps.notifications.forgetDevice(id);
    reply.code(204).send();
  });
}

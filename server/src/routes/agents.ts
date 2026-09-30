import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AGENT_IDS } from '../config.js';
import { MODEL_PRESETS } from '../agents/models.js';
import { httpError, notFound } from '../http/errors.js';
import type { AppDeps } from './deps.js';

export async function agentRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/agents', async () => deps.agents.info());

  fastify.get('/models/:agentId', async (req, reply) => {
    const parse = z.enum(AGENT_IDS).safeParse((req.params as { agentId?: string }).agentId);
    if (!parse.success) {
      throw httpError(
        404,
        'NOT_FOUND',
        `Unknown agent: ${String((req.params as { agentId?: string }).agentId ?? '')}`,
      );
    }
    const agentId = parse.data;
    if (deps.config.agents[agentId].mode === 'off') {
      throw notFound('Agent is disabled');
    }
    reply.send({ models: MODEL_PRESETS[agentId] });
  });
}

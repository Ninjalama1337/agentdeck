import { isAbsolute } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AGENT_IDS } from '../config.js';
import { switchZcodePlan } from '../agents/zcode.js';
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
    // OpenCode's catalog and default model are location-scoped. The app sends
    // the session's project so project config is honoured; other agents ignore it.
    const query = z.object({ path: z.string().min(1).optional() }).parse(req.query);
    const cwd = query.path && isAbsolute(query.path) ? query.path : undefined;
    const catalog = await deps.agents.modelsFor(agentId, cwd);
    reply.send({
      models: catalog.models,
      ...(catalog.defaultModel ? { defaultModel: catalog.defaultModel } : {}),
    });
  });

  fastify.post('/agents/:agentId/plan', async (req, reply) => {
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
    const body = z.object({
      planId: z.enum(['subscription', 'free']),
    }).parse(req.body);

    if (agentId === 'zcode') {
      try {
        switchZcodePlan(body.planId);
        deps.usage.clearCache();
        reply.send({ ok: true, activePlanId: body.planId });
        return;
      } catch (err) {
        throw httpError(500, 'PLAN_SWITCH_FAILED', (err as Error).message);
      }
    }

    throw httpError(400, 'BAD_REQUEST', `Agent ${agentId} does not support plan switching`);
  });
}

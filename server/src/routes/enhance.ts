/**
 * POST /api/enhance — rewrite a rough draft into a crisp prompt via the
 * chosen agent (transient run, nothing persisted). BridgeMind "Enhance".
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { httpError } from '../http/errors.js';
import { EnhanceError, runEnhance } from '../agents/enhance.js';
import { getProjectOr404 } from './projects.js';
import type { AppDeps } from './deps.js';

const EnhanceSchema = z.object({
  projectId: z.string().min(1),
  agentId: z.enum(['claude', 'zcode', 'antigravity', 'codex']),
  text: z.string().trim().min(1).max(20_000),
  model: z.string().optional(),
  thinkingEffort: z.string().optional(),
  accountId: z.string().optional(),
});

export async function enhanceRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.post('/enhance', async (req) => {
    const body = EnhanceSchema.parse(req.body);
    const project = getProjectOr404(deps, body.projectId);
    try {
      const text = await runEnhance(
        { agents: deps.agents, store: deps.store, log: deps.log },
        {
          project,
          agentId: body.agentId,
          text: body.text,
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.thinkingEffort !== undefined ? { thinkingEffort: body.thinkingEffort } : {}),
          ...(body.accountId !== undefined ? { accountId: body.accountId } : {}),
        },
      );
      return { text };
    } catch (err) {
      if (err instanceof EnhanceError) {
        throw httpError(err.code === 'AGENT_UNAVAILABLE' ? 409 : 502, err.code, err.message);
      }
      throw err;
    }
  });
}

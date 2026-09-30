/**
 * Account profiles (BridgeMind multi-account): env overrides per agent so a
 * thread can run on a second login (CLAUDE_CONFIG_DIR, CODEX_HOME, ...).
 * Logins themselves happen in a Terminal — no secrets live here.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { httpError, notFound } from '../http/errors.js';
import type { AppDeps } from './deps.js';

const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;

const AccountBodySchema = z.object({
  name: z.string().trim().min(1).max(60),
  agentId: z.enum(['claude', 'zcode', 'antigravity', 'codex']),
  env: z.record(z.string().max(500)).refine(
    (env) => Object.keys(env).length <= 24 && Object.keys(env).every((k) => ENV_KEY.test(k)),
    { message: 'env keys must be UPPER_SNAKE env names (max 24 entries)' },
  ),
});

export async function accountRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/accounts', async (req) => {
    const query = z.object({ agentId: z.string().optional() }).parse(req.query ?? {});
    return deps.store.listAccounts(query.agentId);
  });

  fastify.post('/accounts', async (req, reply) => {
    const body = AccountBodySchema.parse(req.body);
    if (!deps.agents.infoOf(body.agentId)) throw httpError(400, 'BAD_REQUEST', 'Unknown agent.');
    const account = await deps.store.saveAccount({
      id: deps.store.newAccountId(),
      name: body.name,
      agentId: body.agentId,
      env: body.env,
      createdAt: Date.now(),
    });
    reply.code(201).send(account);
  });

  fastify.delete('/accounts/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.store.deleteAccount(id)) throw notFound('Account not found');
    reply.code(204).send();
  });
}

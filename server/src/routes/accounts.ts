/**
 * Account profiles (BridgeMind multi-account): env overrides per agent so a
 * thread can run on a second login (CLAUDE_CONFIG_DIR, CODEX_HOME, ...).
 * Logins themselves happen in a Terminal — no secrets live here.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { httpError, notFound } from '../http/errors.js';
import type { AppDeps } from './deps.js';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ACCOUNT_AGENTS, CONFIG_DIR_ENV } from '../accounts/active.js';

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
  /** Active account per agent: { claude: "<id>" } — missing = default login. */
  fastify.get('/accounts/active', async () => deps.activeAccounts.all());

  fastify.put('/accounts/active', async (req) => {
    const body = z.object({ agentId: z.enum(ACCOUNT_AGENTS), accountId: z.string().nullable() }).parse(req.body);
    if (body.accountId) {
      const account = deps.store.getAccount(body.accountId);
      if (!account || account.agentId !== body.agentId) throw httpError(400, 'BAD_REQUEST', 'Unknown account for this agent.');
    }
    deps.activeAccounts.set(body.agentId, body.accountId);
    // The usage readout follows the active account.
    deps.usage.clearCache();
    return deps.activeAccounts.all();
  });

  /**
   * New account with its own config folder (CLAUDE_CONFIG_DIR / CODEX_HOME in
   * the data dir). The user then logs in once in a terminal on it.
   */
  fastify.post('/accounts/quick', async (req, reply) => {
    const body = z.object({ agentId: z.enum(['claude', 'codex']), name: z.string().trim().min(1).max(60) }).parse(req.body);
    const id = deps.store.newAccountId();
    const dir = path.join(deps.config.dataDir, 'accounts', id, body.agentId);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const account = await deps.store.saveAccount({
      id,
      name: body.name,
      agentId: body.agentId,
      env: { [CONFIG_DIR_ENV[body.agentId]!]: dir },
      createdAt: Date.now(),
    });
    reply.code(201).send(account);
  });

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

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AdminJob } from '@agentdeck/shared';
import { AGENT_IDS } from '../config.js';
import { httpError, notFound } from '../http/errors.js';
import { ADMIN_JOB_KINDS, recipeFor } from '../admin/recipes.js';
import type { AppDeps } from './deps.js';

const StartJobBody = z.object({
  agentId: z.enum(AGENT_IDS),
  kind: z.enum(ADMIN_JOB_KINDS),
});

/**
 * Agent administration jobs (CONTRACT.md): list/start/inspect the fixed
 * update/install/login recipes. Runs are one-at-a-time and streamed live via
 * the WS `admin:job` event. Authed via the global device hook.
 */
export async function adminRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/admin/jobs', async () => deps.adminJobs.list());

  fastify.post('/admin/jobs', async (req, reply) => {
    const parse = StartJobBody.safeParse(req.body);
    if (!parse.success) {
      const first = parse.error.issues[0];
      const where = first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid request';
      throw httpError(400, 'BAD_REQUEST', where);
    }
    const { agentId, kind } = parse.data;
    if (deps.config.agents[agentId].mode === 'off') {
      throw httpError(400, 'BAD_REQUEST', `Agent ${agentId} is disabled (mode: off).`);
    }
    // Throws 400 ADMIN_JOB_UNAVAILABLE carrying the unavailableReason for
    // TUI/IDE-only logins (e.g. claude login).
    const recipe = recipeFor(agentId, kind);
    // Throws 409 ADMIN_JOB_ACTIVE while another job runs.
    const job = deps.adminJobs.start(agentId, kind, recipe);
    reply.code(202).send(job as AdminJob);
  });

  fastify.get('/admin/jobs/:id', async (req) => {
    const id = (req.params as { id?: string }).id ?? '';
    const job = deps.adminJobs.get(id);
    if (!job) throw notFound('Admin job not found');
    return job;
  });

  fastify.post('/admin/jobs/:id/stop', async (req, reply) => {
    const id = (req.params as { id?: string }).id ?? '';
    const job = deps.adminJobs.get(id);
    if (!job) throw notFound('Admin job not found');
    if (!deps.adminJobs.stopJob(id)) {
      throw httpError(409, 'ADMIN_JOB_NOT_ACTIVE', 'Job is not running (anymore).');
    }
    reply.code(204).send();
  });
}

/**
 * Routine CRUD + "fire now" (BridgeMind: agents on recurring jobs).
 */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Routine, RoutineSchedule } from '@agentdeck/shared';
import { z } from 'zod';
import { AgentIdSchema } from '../config.js';
import { httpError, notFound } from '../http/errors.js';
import { nextRunAt, validateSchedule } from '../routines/scheduler.js';
import { getProjectOr404 } from './projects.js';
import { effortOr400 } from './sessions.js';
import type { AppDeps } from './deps.js';

const ScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interval'), minutes: z.number() }),
  z.object({ kind: z.literal('daily'), time: z.string() }),
  z.object({ kind: z.literal('weekly'), weekday: z.number(), time: z.string() }),
  z.object({ kind: z.literal('commit') }),
  z.object({ kind: z.literal('ci-failed') }),
  z.object({ kind: z.literal('webhook') }),
]);

const RoutineBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  projectId: z.string().min(1),
  agentId: AgentIdSchema,
  prompt: z.string().trim().min(1).max(20_000),
  model: z.string().optional(),
  thinkingEffort: z.string().optional(),
  accountId: z.string().optional(),
  schedule: ScheduleSchema,
  enabled: z.boolean().optional(),
  freshContext: z.boolean().optional(),
});

/** What a hook caller may send along: JSON, or plain text. */
const HOOK_BODY_MAX = 16_000;

function newHookToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function scheduleOr400(schedule: RoutineSchedule): RoutineSchedule {
  const problem = validateSchedule(schedule);
  if (problem) throw httpError(400, 'BAD_REQUEST', `Invalid schedule: ${problem}`);
  return schedule;
}

/** Enriched routine view: derived next fire time for the UI. */
function withNext(routine: Routine): Routine & { nextRunAt: number | null } {
  return { ...routine, nextRunAt: routine.enabled ? nextRunAt(routine) : null };
}

export async function routineRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/routines', async (req) => {
    const query = z.object({ projectId: z.string().optional() }).parse(req.query ?? {});
    return deps.store.listRoutines(query.projectId).map(withNext);
  });

  fastify.get('/routines/:id', async (req) => {
    const routine = deps.store.getRoutine((req.params as { id: string }).id);
    if (!routine) throw notFound('Routine not found');
    return withNext(routine);
  });

  fastify.post('/routines', async (req, reply) => {
    const body = RoutineBodySchema.parse(req.body);
    getProjectOr404(deps, body.projectId);
    const thinkingEffort = effortOr400(body.thinkingEffort);
    if (body.accountId) {
      const account = deps.store.getAccount(body.accountId);
      if (!account || account.agentId !== body.agentId) {
        throw httpError(400, 'BAD_REQUEST', 'Unknown account for this agent.');
      }
    }
    const now = Date.now();
    const routine = await deps.store.saveRoutine({
      id: deps.store.newRoutineId(),
      name: body.name,
      projectId: body.projectId,
      agentId: body.agentId,
      prompt: body.prompt,
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
      ...(body.accountId !== undefined ? { accountId: body.accountId } : {}),
      schedule: scheduleOr400(body.schedule),
      enabled: body.enabled ?? true,
      ...(body.freshContext ? { freshContext: true } : {}),
      ...(body.schedule.kind === 'webhook' ? { hookToken: newHookToken() } : {}),
      createdAt: now,
      updatedAt: now,
    });
    reply.code(201).send(withNext(routine));
  });

  fastify.patch('/routines/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const existing = deps.store.getRoutine(id);
    if (!existing) throw notFound('Routine not found');
    const body = RoutineBodySchema.partial().parse(req.body);
    if (body.projectId && body.projectId !== existing.projectId) getProjectOr404(deps, body.projectId);
    const thinkingEffort = body.thinkingEffort !== undefined ? effortOr400(body.thinkingEffort) : undefined;
    if (body.accountId !== undefined && body.accountId) {
      const account = deps.store.getAccount(body.accountId);
      if (!account || account.agentId !== (body.agentId ?? existing.agentId)) {
        throw httpError(400, 'BAD_REQUEST', 'Unknown account for this agent.');
      }
    }
    const routine = await deps.store.saveRoutine({
      ...existing,
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
      ...(body.agentId !== undefined ? { agentId: body.agentId } : {}),
      ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
      ...(body.accountId !== undefined ? { accountId: body.accountId } : {}),
      ...(body.schedule !== undefined ? { schedule: scheduleOr400(body.schedule) } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.freshContext !== undefined ? { freshContext: body.freshContext } : {}),
      // schedule changes reset the cadence anchor and what an event routine saw last
      ...(body.schedule !== undefined ? { lastRunAt: undefined, triggerState: undefined } : {}),
      ...(body.schedule?.kind === 'webhook' && !existing.hookToken ? { hookToken: newHookToken() } : {}),
    });
    return withNext(routine);
  });

  fastify.delete('/routines/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.store.deleteRoutine(id)) throw notFound('Routine not found');
    reply.code(204).send();
  });

  // The runs of a routine, newest first — from the activity database.
  fastify.get('/routines/:id/runs', async (req) => {
    const id = (req.params as { id: string }).id;
    if (!deps.store.getRoutine(id)) throw notFound('Routine not found');
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(100).optional(), before: z.coerce.number().int().optional() })
      .parse(req.query ?? {});
    return deps.stats.runs({ routineId: id, limit: query.limit ?? 20, ...(query.before ? { before: query.before } : {}) });
  });

  // A new hook URL: the old one stops working.
  fastify.post('/routines/:id/hook-token', async (req) => {
    const existing = deps.store.getRoutine((req.params as { id: string }).id);
    if (!existing) throw notFound('Routine not found');
    return withNext(await deps.store.saveRoutine({ ...existing, hookToken: newHookToken() }));
  });

  /**
   * The hook of a `webhook` routine — called by CI, a cron job, another
   * service. No device login: the secret in the URL is the key (the auth hook
   * lets /api/hooks/ through). The body, if any, reaches the agent with the prompt.
   */
  fastify.post('/hooks/routine/:id/:token', async (req, reply) => {
    const { id, token } = req.params as { id: string; token: string };
    if (!deps.hookLimiter.allow(req.ip)) throw httpError(429, 'RATE_LIMITED', 'Too many requests.');
    const routine = deps.store.getRoutine(id);
    // One answer for "no such routine" and "wrong secret": nothing to probe.
    if (!routine || routine.schedule.kind !== 'webhook' || !routine.hookToken || !sameSecret(routine.hookToken, token)) {
      throw notFound('Not found');
    }
    if (!routine.enabled) throw httpError(409, 'ROUTINE_PAUSED', 'This routine is paused.');
    const body = req.body;
    const payload = typeof body === 'string' ? body : body && typeof body === 'object' ? JSON.stringify(body, null, 2) : '';
    const context = payload.trim() ? `Webhook payload:\n${payload.trim().slice(0, HOOK_BODY_MAX)}` : undefined;
    // Not awaited: the caller learns that the run started, not how it ended.
    void deps.routines.fire(id, 'webhook', context);
    reply.code(202).send({ ok: true });
  });

  fastify.post('/routines/:id/run', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.store.getRoutine(id)) throw notFound('Routine not found');
    const result = await deps.routines.fire(id, 'manual');
    reply.code(result.status === 'missing' ? 404 : 200).send(result);
  });
}

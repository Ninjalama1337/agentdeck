/**
 * Routine CRUD + "fire now" (BridgeMind: agents on recurring jobs).
 */
import type { FastifyInstance } from 'fastify';
import type { Routine, RoutineSchedule } from '@agentdeck/shared';
import { z } from 'zod';
import { httpError, notFound } from '../http/errors.js';
import { nextRunAt, validateSchedule } from '../routines/scheduler.js';
import { getProjectOr404 } from './projects.js';
import { effortOr400 } from './sessions.js';
import type { AppDeps } from './deps.js';

const ScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('interval'), minutes: z.number() }),
  z.object({ kind: z.literal('daily'), time: z.string() }),
  z.object({ kind: z.literal('weekly'), weekday: z.number(), time: z.string() }),
]);

const RoutineBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  projectId: z.string().min(1),
  agentId: z.enum(['claude', 'zcode', 'antigravity', 'codex']),
  prompt: z.string().trim().min(1).max(20_000),
  model: z.string().optional(),
  thinkingEffort: z.string().optional(),
  accountId: z.string().optional(),
  schedule: ScheduleSchema,
  enabled: z.boolean().optional(),
});

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
      // schedule changes reset the cadence anchor
      ...(body.schedule !== undefined ? { lastRunAt: undefined } : {}),
    });
    return withNext(routine);
  });

  fastify.delete('/routines/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.store.deleteRoutine(id)) throw notFound('Routine not found');
    reply.code(204).send();
  });

  fastify.post('/routines/:id/run', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.store.getRoutine(id)) throw notFound('Routine not found');
    const result = await deps.routines.fire(id, 'manual');
    reply.code(result.status === 'missing' ? 404 : 200).send(result);
  });
}

/**
 * Parallel worktrees: POST /projects/:id/parallel starts one agent per
 * worktree with the same prompt; the rest compares, merges or discards them
 * (see git/worktrees.ts).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ParallelLaunchResponse, TerminalInfo, WorktreeInfo } from '@agentdeck/shared';
import { httpError } from '../http/errors.js';
import { getProjectOr404 } from './projects.js';
import { knownTimeZone, terminalBroadcasts } from './terminals.js';
import { PRESET_DEFS, resolveLaunch } from '../term/presets.js';
import type { AppDeps } from './deps.js';

const ParallelSchema = z.object({
  prompt: z.string().trim().min(1).max(8000),
  agents: z
    .array(z.object({ presetId: z.string().max(40), variantId: z.string().max(40).optional() }))
    .min(1)
    .max(4),
  cols: z.number().int().min(10).max(500).optional(),
  rows: z.number().int().min(4).max(300).optional(),
  timeZone: z.string().max(64).optional(),
});

export async function worktreeRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  const live = () => new Set(deps.terminals.list().map((t) => t.id));

  fastify.get('/projects/:id/worktrees', async (req) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    return deps.worktrees.list(project.id, live());
  });

  fastify.post('/projects/:id/parallel', async (req, reply) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    const body = ParallelSchema.parse(req.body);
    // Check every agent before creating anything.
    for (const a of body.agents) {
      const def = PRESET_DEFS.find((p) => p.id === a.presetId);
      if (!def?.promptArg) throw httpError(400, 'BAD_PRESET', `${def?.label ?? a.presetId} cannot run in parallel (no start prompt)`);
    }
    const timeZone = knownTimeZone(body.timeZone);
    const worktrees: WorktreeInfo[] = [];
    const terminals: TerminalInfo[] = [];
    for (const a of body.agents) {
      const launch = resolveLaunch(a.presetId, a.variantId, undefined, body.prompt);
      const wt = await deps.worktrees.create(project.id, project.path, { prompt: body.prompt, presetId: launch.presetId, label: launch.title });
      const info = deps.terminals.spawn(wt.path, project.id, body.cols ?? 80, body.rows ?? 24, terminalBroadcasts(deps), {
        title: `${launch.title} · ${wt.name.split('-').slice(-1)[0]}`,
        presetId: launch.presetId,
        ...(launch.variantId ? { variantId: launch.variantId } : {}),
        idleNotify: launch.agent,
        ...(launch.command ? { command: launch.command } : {}),
        ...(timeZone ? { timeZone } : {}),
      });
      await deps.worktrees.setTerminal(project.id, wt.name, info.id);
      worktrees.push({ ...wt, terminalId: info.id });
      terminals.push(info);
    }
    reply.code(201).send({ worktrees, terminals } satisfies ParallelLaunchResponse);
  });

  fastify.get('/projects/:id/worktrees/:name/diff', async (req) => {
    const { id, name } = req.params as { id: string; name: string };
    const project = getProjectOr404(deps, id);
    return deps.worktrees.diff(project.id, name);
  });

  fastify.post('/projects/:id/worktrees/:name/apply', async (req) => {
    const { id, name } = req.params as { id: string; name: string };
    const project = getProjectOr404(deps, id);
    const res = await deps.worktrees.apply(project.id, project.path, name);
    deps.fileWatchers.ensureStarted(project.id, project.path);
    return res;
  });

  fastify.delete('/projects/:id/worktrees/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const project = getProjectOr404(deps, id);
    const all = await deps.worktrees.list(project.id, live());
    const wt = all.find((w) => w.name === name);
    // The agent goes with its worktree.
    if (wt?.terminalId) deps.terminals.kill(wt.terminalId, terminalBroadcasts(deps));
    await deps.worktrees.remove(project.id, project.path, name);
    reply.code(204).send();
  });
}

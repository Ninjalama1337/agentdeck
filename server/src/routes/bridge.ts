/**
 * Bridge API (bridge token + localhost only) — used by the agentdeck-mcp
 * binary and, indirectly, by IDE agents delegating to headless agents.
 */
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Project } from '@agentdeck/shared';
import { z } from 'zod';
import { AgentIdSchema } from '../config.js';
import { notFound } from '../http/errors.js';
import { ensureDir } from '../util/paths.js';
import { newProjectId } from '../util/ids.js';
import { resolveInsideRoot } from '../files/sandbox.js';
import { listDirectory } from '../files/browser.js';
import type { AppDeps } from './deps.js';

const BridgeRunSchema = z.object({
  agent: AgentIdSchema,
  prompt: z.string().min(1).max(500_000),
  project: z.string().optional(),
  model: z.string().optional(),
  timeoutMs: z.number().int().positive().max(24 * 60 * 60 * 1000).optional(),
});

/** Finds the bridge fallback project (`bridge`), creating it on demand. */
async function bridgeProject(deps: AppDeps): Promise<Project> {
  const existing = deps.store.listProjects().find((p) => p.name === 'bridge');
  if (existing) return existing;
  const now = Date.now();
  const project: Project = {
    id: newProjectId(),
    name: 'bridge',
    path: path.join(deps.config.projectsRoot, 'bridge'),
    createdAt: now,
    updatedAt: now,
  };
  await ensureDir(project.path);
  await deps.store.saveProject(project, { touch: false });
  return project;
}

async function resolveBridgeProject(deps: AppDeps, idOrName?: string): Promise<Project> {
  if (idOrName) {
    const found = deps.store.findProjectByNameOrId(idOrName);
    if (found) return found;
    throw notFound(`Project not found: ${idOrName}`);
  }
  return bridgeProject(deps);
}

export async function bridgeRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/bridge/agents', { preHandler: deps.bridgeGuard }, async () => deps.agents.info());

  fastify.get('/bridge/files', { preHandler: deps.bridgeGuard }, async (req) => {
    const query = z
      .object({ project: z.string().optional(), path: z.string().default('') })
      .parse(req.query ?? {});
    const project = await resolveBridgeProject(deps, query.project);
    const resolved = await resolveInsideRoot(project.path, query.path, { create: true });
    return listDirectory(resolved.abs, resolved.rel);
  });

  fastify.post('/bridge/run', { preHandler: deps.bridgeGuard }, async (req, reply) => {
    const body = BridgeRunSchema.parse(req.body);
    const project = await resolveBridgeProject(deps, body.project);
    const session = await deps.store.newSession(
      {
        projectId: project.id,
        agentId: body.agent,
        title: body.prompt.slice(0, 60),
        ...(body.model !== undefined ? { model: body.model } : {}),
      },
      'mcp',
    );

    await deps.store.appendMessage({
      id: `m_${session.id}_0`,
      sessionId: session.id,
      role: 'user',
      agentId: body.agent,
      text: body.prompt,
      attachments: [],
      ts: Date.now(),
      source: 'mcp',
    });

    const outcome = await deps.manager.startTurn({
      session,
      project,
      text: body.prompt,
      attachments: [],
      ...(body.model !== undefined ? { model: body.model } : {}),
      source: 'mcp',
      ...(body.timeoutMs !== undefined ? { maxRunMs: body.timeoutMs } : {}),
    });

    reply.send({
      ok: outcome.ok,
      ...(outcome.text ? { text: outcome.text } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
      sessionId: session.id,
    });
  });
}

import path from 'node:path';
import fsp from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Project } from '@agentdeck/shared';
import { notFound } from '../http/errors.js';
import { sanitizeFileName, ensureDir } from '../util/paths.js';
import { newProjectId } from '../util/ids.js';
import {
  cloneRepo,
  findFreeCloneTarget,
  gitCommit,
  gitInit,
  gitPush,
  gitStatus,
  sanitizeCloneName,
} from '../git/gitOps.js';
import { listGithubRepos } from '../git/github.js';
import type { AppDeps } from './deps.js';

function getProjectOr404(deps: AppDeps, id: string): Project {
  const project = deps.store.getProject(id);
  if (!project) throw notFound('Project not found');
  return project;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function projectRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/projects', async () => deps.store.listProjects());

  fastify.post('/projects', async (req, reply) => {
    const body = z
      .object({
        name: z.string().min(1).max(120),
        initGit: z.boolean().optional(),
      })
      .parse(req.body);
    const name = body.name.trim();
    const slug = sanitizeFileName(name.replace(/\s+/g, '-'));
    let target = path.join(deps.config.projectsRoot, slug);
    // Never clobber an existing directory: suffix until free.
    for (let i = 2; await dirExists(target); i++) {
      target = path.join(deps.config.projectsRoot, `${slug}-${i}`);
    }
    await ensureDir(target);
    const now = Date.now();
    const project: Project = {
      id: newProjectId(),
      name,
      path: target,
      createdAt: now,
      updatedAt: now,
    };
    if (body.initGit) {
      try {
        await gitInit(target);
      } catch {
        // git unavailable — project still gets created
      }
    }
    project.git = await gitStatus(target);
    await deps.store.saveProject(project, { touch: false });
    reply.code(201).send(project);
  });

  fastify.post('/projects/clone', async (req, reply) => {
    const body = z
      .object({
        url: z.string().url(),
        name: z.string().max(120).optional(),
      })
      .parse(req.body);
    const name = sanitizeCloneName(body.name, body.url);
    const target = await findFreeCloneTarget(deps.config.projectsRoot, name);
    const now = Date.now();
    const project: Project = {
      id: newProjectId(),
      name,
      path: target,
      createdAt: now,
      updatedAt: now,
    };
    await deps.store.saveProject(project, { touch: false });

    // Async clone job: progress milestones via project:update, notify on completion.
    void (async () => {
      let lastSent = 0;
      try {
        await cloneRepo(body.url, target, {
          onProgress: (percent) => {
            if (percent - lastSent >= 10) {
              lastSent = percent;
              void deps.store.saveProject(project).catch(() => undefined);
            }
          },
        });
        project.git = await gitStatus(target);
        await deps.store.saveProject(project);
        deps.broadcast('notify', { level: 'info', text: `Cloned ${body.url} into ${name}` });
      } catch (err) {
        await deps.store.deleteProject(project.id).catch(() => undefined);
        const message = err instanceof Error ? err.message : String(err);
        deps.log.warn({ err }, 'clone failed');
        deps.broadcast('notify', { level: 'error', text: `Clone failed: ${message}` });
      }
    })();

    reply.code(202).send(project);
  });

  fastify.delete('/projects/:id', async (req, reply) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    await deps.store.deleteProject(project.id);
    deps.broadcast('notify', {
      level: 'info',
      text: `Project "${project.name}" removed from the registry (files kept at ${project.path}).`,
    });
    reply.code(204).send();
  });

  // Git ---------------------------------------------------------------------

  fastify.get('/projects/:id/git/status', async (req) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    return (await gitStatus(project.path)) ?? {};
  });

  fastify.post('/projects/:id/git/commit', async (req) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    const body = z
      .object({
        message: z.string().min(1).max(2000),
        all: z.boolean().optional(),
      })
      .parse(req.body);
    const info = await gitCommit(project.path, body.message, body.all !== false);
    project.git = info;
    await deps.store.saveProject(project);
    return info;
  });

  fastify.post('/projects/:id/git/push', async (req) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    return gitPush(project.path);
  });

  // GitHub ------------------------------------------------------------------

  fastify.get('/github/repos', async (req) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        q: z.string().optional(),
      })
      .parse(req.query ?? {});
    return listGithubRepos(query.limit, query.q);
  });
}

export { getProjectOr404 };

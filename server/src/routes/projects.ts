import path from 'node:path';
import fsp from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Project } from '@agentdeck/shared';
import { AgentIdSchema } from '../config.js';
import { httpError, notFound } from '../http/errors.js';
import { EnhanceError, runEnhance } from '../agents/enhance.js';
import { sanitizeFileName, ensureDir } from '../util/paths.js';
import { newProjectId } from '../util/ids.js';
import { listBrowseDirs, resolveBrowseDir, resolveBrowseRoot } from '../files/explorer.js';
import {
  cloneRepo,
  findFreeCloneTarget,
  gitBranches,
  gitChanges,
  gitCheckout,
  gitCommit,
  gitDiff,
  gitDiffForMessage,
  gitDiscard,
  gitFetch,
  gitInit,
  gitLog,
  gitPull,
  gitPush,
  gitShow,
  gitStatus,
  sanitizeCloneName,
} from '../git/gitOps.js';
import { githubItemDetail, listGithubItems, listGithubRepos } from '../git/github.js';
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

  // Adopt an existing directory on this machine (e.g. a repo checked out
  // elsewhere) as a project, via the folder picker.
  fastify.post('/projects/open', async (req, reply) => {
    const body = z
      .object({
        path: z.string().min(1).max(4096),
        name: z.string().min(1).max(120).optional(),
      })
      .parse(req.body ?? {});
    const rootReal = await resolveBrowseRoot(deps.config.browseRoot);
    const dir = await resolveBrowseDir(rootReal, body.path);

    const existing = deps.store.listProjects().find((p) => path.resolve(p.path) === dir);
    if (existing) {
      reply.code(200).send(existing);
      return;
    }

    const name = (body.name?.trim() || path.basename(dir) || 'project').slice(0, 120);
    const now = Date.now();
    const project: Project = {
      id: newProjectId(),
      name,
      path: dir,
      createdAt: now,
      updatedAt: now,
    };
    project.git = await gitStatus(dir);
    await deps.store.saveProject(project, { touch: false });
    deps.broadcast('notify', { level: 'info', text: `Opened ${name} at ${dir}` });
    reply.code(201).send(project);
  });

  // Folder picker: directories under the configured browse root.
  fastify.get('/fs/browse', async (req) => {
    const query = z
      .object({ path: z.string().max(4096).optional(), all: z.string().optional() })
      .parse(req.query ?? {});
    const rootReal = await resolveBrowseRoot(deps.config.browseRoot);
    const dir = await resolveBrowseDir(rootReal, query.path);
    return listBrowseDirs(rootReal, dir, { all: query.all === '1' });
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
        message: z.string().min(1).max(5000),
        all: z.boolean().optional(),
        files: z.array(z.string().min(1).max(1000)).max(2000).optional(),
      })
      .parse(req.body);
    const info = await gitCommit(project.path, body.message, body.all !== false, body.files);
    project.git = info;
    await deps.store.saveProject(project);
    return info;
  });

  fastify.post('/projects/:id/git/push', async (req) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    return gitPush(project.path);
  });

  fastify.get('/projects/:id/git/changes', async (req) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    return gitChanges(project.path);
  });

  fastify.get('/projects/:id/git/diff', async (req) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    const query = z.object({ path: z.string().max(1000).optional() }).parse(req.query ?? {});
    return gitDiff(project.path, query.path);
  });

  fastify.get('/projects/:id/git/log', async (req) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(30) }).parse(req.query ?? {});
    return gitLog(project.path, query.limit);
  });

  fastify.get('/projects/:id/git/show/:hash', async (req) => {
    const params = req.params as { id: string; hash: string };
    const project = getProjectOr404(deps, params.id);
    return gitShow(project.path, params.hash);
  });

  fastify.get('/projects/:id/git/branches', async (req) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    return gitBranches(project.path);
  });

  fastify.post('/projects/:id/git/checkout', async (req) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    const body = z.object({ branch: z.string().min(1).max(200), create: z.boolean().optional() }).parse(req.body);
    const result = await gitCheckout(project.path, body.branch, body.create === true);
    await refreshProjectGit(deps, project);
    return result;
  });

  fastify.post('/projects/:id/git/pull', async (req) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    const result = await gitPull(project.path);
    await refreshProjectGit(deps, project);
    return result;
  });

  fastify.post('/projects/:id/git/fetch', async (req) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    const result = await gitFetch(project.path);
    await refreshProjectGit(deps, project);
    return result;
  });

  fastify.post('/projects/:id/git/discard', async (req, reply) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    const body = z.object({ path: z.string().min(1).max(1000) }).parse(req.body);
    await gitDiscard(project.path, body.path);
    await refreshProjectGit(deps, project);
    reply.code(204).send();
  });

  /** AI commit message from the current diff (transient agent run). */
  fastify.post('/projects/:id/git/suggest-message', async (req) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    const body = z
      .object({
        agentId: AgentIdSchema.default('claude'),
        files: z.array(z.string().max(1000)).max(2000).optional(),
        model: z.string().optional(),
      })
      .parse(req.body ?? {});
    const diff = await gitDiffForMessage(project.path, body.files);
    if (!diff.trim()) throw httpError(409, 'NOTHING_TO_COMMIT', 'No changes to describe.');
    const prompt = [
      'Write a git commit message for the changes below.',
      'Format: a concise imperative subject line (max 72 chars), then optionally a blank line',
      'and a short bullet list of the important changes. Match the language of existing',
      'code comments if obvious, otherwise English. Reply with the commit message ONLY —',
      'no code fences, no preamble.',
      '',
      diff,
    ].join('\n');
    try {
      const text = await runEnhance(
        { agents: deps.agents, store: deps.store, log: deps.log },
        {
          project,
          agentId: body.agentId,
          text: prompt,
          raw: true,
          ...(body.model ? { model: body.model } : {}),
        },
      );
      return { text: text.replace(/^```[a-z]*\n?|```$/g, '').trim() };
    } catch (err) {
      if (err instanceof EnhanceError) {
        throw httpError(err.code === 'AGENT_UNAVAILABLE' ? 409 : 502, err.code, err.message);
      }
      throw err;
    }
  });

  // GitHub ------------------------------------------------------------------

  fastify.get('/projects/:id/github/items', async (req) => {
    const project = getProjectOr404(deps, (req.params as { id: string }).id);
    return listGithubItems(project.path);
  });

  fastify.get('/projects/:id/github/:kind/:number', async (req) => {
    const params = z
      .object({ id: z.string(), kind: z.enum(['issue', 'pr']), number: z.coerce.number().int().positive() })
      .parse(req.params);
    const project = getProjectOr404(deps, params.id);
    return githubItemDetail(project.path, params.kind, params.number);
  });

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

async function refreshProjectGit(deps: AppDeps, project: Project): Promise<void> {
  const info = await gitStatus(project.path).catch(() => undefined);
  if (info) {
    project.git = info;
    await deps.store.saveProject(project);
  }
}

export { getProjectOr404 };

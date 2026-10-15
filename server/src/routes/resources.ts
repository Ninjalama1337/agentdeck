import type { FastifyInstance } from 'fastify';
import type { ResourcesResponse, TerminalResources } from '@agentdeck/shared';
import { httpError, notFound } from '../http/errors.js';
import { processTree, sampleProcesses, systemLoad } from '../term/resources.js';
import type { AppDeps } from './deps.js';

/** CPU and memory of every terminal's process tree; ending a single process in it. */
export async function resourceRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/terminals/resources', async (): Promise<ResourcesResponse> => {
    const all = await sampleProcesses();
    const terminals: TerminalResources[] = deps.terminals.rootPids().map(({ id, pid }) => {
      const tree = processTree(pid, all);
      const [root, ...rest] = tree;
      const heavy = rest.sort((a, b) => b.cpu - a.cpu || b.rss - a.rss).slice(0, 11);
      return {
        id,
        cpu: Math.round(tree.reduce((s, p) => s + p.cpu, 0)),
        mem: tree.reduce((s, p) => s + p.rss, 0),
        count: tree.length,
        processes: [...(root ? [root] : []), ...heavy].map((p) => ({ pid: p.pid, name: p.name, cpu: Math.round(p.cpu), mem: p.rss })),
      };
    });
    return { terminals, system: systemLoad() };
  });

  fastify.post('/terminals/:id/processes/:pid/kill', async (req, reply) => {
    const { id, pid: raw } = req.params as { id: string; pid: string };
    const pid = Number(raw);
    const root = deps.terminals.rootPids().find((r) => r.id === id);
    if (!root) throw notFound('Terminal not found');
    // Only what runs below this terminal — never an arbitrary process of the machine.
    const tree = processTree(root.pid, await sampleProcesses());
    if (!Number.isInteger(pid) || !tree.some((p) => p.pid === pid)) throw httpError(404, 'NOT_FOUND', 'No such process in this terminal');
    if (pid === root.pid) throw httpError(400, 'IS_SHELL', 'That is the terminal itself — end the terminal instead');
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      throw httpError(409, 'KILL_FAILED', err instanceof Error ? err.message : String(err));
    }
    reply.code(204).send();
  });
}

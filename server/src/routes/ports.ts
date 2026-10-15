import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PortInfo, PreviewLinkResponse } from '@agentdeck/shared';
import { httpError } from '../http/errors.js';
import { listeningPorts } from '../preview/ports.js';
import { signPreviewToken } from '../preview/proxy.js';
import { processTree, sampleProcesses } from '../term/resources.js';
import type { AppDeps } from './deps.js';

/** Ports the terminals' processes listen on, and signed links to preview them. */
export async function portRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/ports', async (): Promise<PortInfo[]> => {
    const roots = deps.terminals.rootPids();
    if (roots.length === 0) return [];
    const all = await sampleProcesses();
    const owner = new Map<number, { terminalId: string; name: string }>();
    for (const { id, pid } of roots) for (const p of processTree(pid, all)) owner.set(p.pid, { terminalId: id, name: p.name });
    const infos = new Map(deps.terminals.list().map((t) => [t.id, t]));
    const ports = await listeningPorts(new Set(owner.keys()));
    return ports
      .filter((p) => p.port !== deps.config.port && p.port !== deps.preview.port)
      .map((p) => {
        const o = owner.get(p.pid)!;
        return { terminalId: o.terminalId, projectId: infos.get(o.terminalId)?.projectId ?? '', port: p.port, pid: p.pid, process: o.name, address: p.address };
      })
      .sort((a, b) => a.port - b.port);
  });

  fastify.post('/ports/:port/preview', async (req): Promise<PreviewLinkResponse> => {
    const port = z.coerce.number().int().min(1).max(65535).parse((req.params as { port: string }).port);
    if (!deps.preview.running) throw httpError(503, 'PREVIEW_OFF', `The preview proxy could not start (port ${deps.preview.port} busy?)`);
    const token = signPreviewToken(deps.jwtSecret, port);
    // The same machine name the app used, on the proxy's port.
    const host = (req.headers.host ?? 'localhost').replace(/:\d+$/, '');
    const remote = req.headers['cf-ray'] !== undefined;
    return { url: `http://${host}:${deps.preview.port}/__agentdeck_preview?t=${encodeURIComponent(token)}`, remote };
  });
}

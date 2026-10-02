import type { FastifyInstance } from 'fastify';
import type { AppDeps } from './deps.js';
import { healthRoutes, pairRoutes } from './health.js';
import { agentRoutes } from './agents.js';
import { deviceRoutes } from './devices.js';
import { projectRoutes } from './projects.js';
import { fileRoutes } from './files.js';
import { fileEditRoutes } from './filesEdit.js';
import { sessionRoutes } from './sessions.js';
import { teamRoutes } from './team.js';
import { bridgeRoutes } from './bridge.js';
import { tunnelRoutes } from './tunnel.js';
import { apkRoutes } from './apk.js';
import { usageRoutes } from './usage.js';
import { adminRoutes } from './admin.js';
import { updateRoutes } from './update.js';
import { terminalRoutes } from './terminals.js';
import { routineRoutes } from './routines.js';
import { accountRoutes } from './accounts.js';
import { enhanceRoutes } from './enhance.js';
import { notificationRoutes } from './notifications.js';

/** Registers every route module under /api. */
export async function registerRoutes(fastify: FastifyInstance, opts: { deps: AppDeps }): Promise<void> {
  const deps = opts.deps;
  await healthRoutes(fastify, deps);
  await pairRoutes(fastify, deps);
  await tunnelRoutes(fastify, deps);
  await apkRoutes(fastify, deps);
  await usageRoutes(fastify, deps);
  await adminRoutes(fastify, deps);
  await updateRoutes(fastify, deps);
  await agentRoutes(fastify, deps);
  await deviceRoutes(fastify, deps);
  await projectRoutes(fastify, deps);
  await fileRoutes(fastify, deps);
  await fileEditRoutes(fastify, deps);
  await sessionRoutes(fastify, deps);
  await teamRoutes(fastify, deps);
  await terminalRoutes(fastify, deps);
  await routineRoutes(fastify, deps);
  await accountRoutes(fastify, deps);
  await enhanceRoutes(fastify, deps);
  await notificationRoutes(fastify, deps);
  await bridgeRoutes(fastify, deps);
}

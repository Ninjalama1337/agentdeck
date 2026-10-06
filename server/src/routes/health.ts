import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NAME, VERSION } from '../version.js';
import { httpError, notFound } from '../http/errors.js';
import { clientIp, isLanRequest } from '../util/ip.js';
import { signDeviceToken } from '../auth/jwt.js';
import type { PairPendingResponse, PairResponse, PairStatusResponse } from '@agentdeck/shared';
import type { AppDeps } from './deps.js';

/** Name/version/bind address — what a paired device shows for this server. */
function serverInfo(deps: AppDeps): { name: string; version: string; host: string } {
  return {
    name: deps.config.serverName,
    version: VERSION,
    host: `${deps.config.host}:${deps.config.port}`,
  };
}

export async function healthRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/health', async () => {
    // Per contract the tunnel block only appears when a provider is enabled.
    const tunnel =
      deps.config.tunnel.provider !== 'off' ? { ...deps.tunnel.healthInfo() } : undefined;
    return {
      ok: true,
      name: NAME,
      version: VERSION,
      agents: deps.agents.allInfo().map((a) => ({ id: a.id, available: a.available })),
      ...(tunnel ? { tunnel } : {}),
    };
  });

  // Authed (unlike /health): the server name is the machine's hostname by default.
  fastify.get('/server', async () => serverInfo(deps));
}

const PairSchema = z.object({
  code: z.string().min(1).max(16),
  deviceName: z.string().min(1).max(64),
});

const PairStatusSchema = z.object({
  id: z.string().min(1).max(64),
  pollToken: z.string().min(1).max(128),
});

/** One bucket for every client outside the LAN: their addresses are theirs to choose. */
const REMOTE_BUCKET = 'remote';

async function rotateCode(deps: AppDeps): Promise<string> {
  const code = await deps.pairing.rotate();
  // Keep the deps snapshot fresh for anyone reading it (banner already printed).
  (deps as { pairingCode: string }).pairingCode = code;
  return code;
}

async function issueToken(deps: AppDeps, deviceName: string): Promise<PairResponse> {
  const device = await deps.store.registerDevice(deviceName);
  const token = await signDeviceToken(deps.jwtSecret, { deviceId: device.id, name: device.name });
  deps.log.debug({ device: device.id }, 'device paired');
  return { token, server: serverInfo(deps) };
}

export async function pairRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  const announceRequests = (): void => deps.broadcast('pair:requests', { requests: deps.pairRequests.list() });

  fastify.post('/pair', async (req, reply) => {
    const body = PairSchema.parse(req.body);
    // Behind a tunnel the socket peer is cloudflared (127.0.0.1) and the real
    // client IP is in x-forwarded-for — clientIp resolves both cases so each
    // remote client gets its own attempt bucket. From the LAN the code alone
    // pairs; a request that reached us through a tunnel or proxy additionally
    // has to be approved on a device that is already paired.
    const ip = clientIp(req);
    const remote = !isLanRequest(req);
    if (remote && deps.store.listDevices().length === 0) {
      throw httpError(
        403,
        'FORBIDDEN',
        'The first device has to be paired from the local network. Join the same network as the server and use its LAN address (http://<lan-ip>:<port>) — further devices can then pair from anywhere, confirmed on this one.',
      );
    }
    if (deps.limiter.isBlocked(ip) || (remote && deps.remoteLimiter.isBlocked(REMOTE_BUCKET))) {
      throw httpError(
        429,
        'TOO_MANY_ATTEMPTS',
        'Too many failed pairing attempts. Try again in 10 minutes.',
      );
    }
    if (remote && deps.pairRequests.isFull()) {
      throw httpError(
        429,
        'TOO_MANY_ATTEMPTS',
        'Other devices are already waiting for approval. Answer them on a paired device, then try again.',
      );
    }
    const expected = await deps.pairing.read();
    if (!expected || body.code.trim() !== expected) {
      deps.limiter.recordFailure(ip);
      if (remote) deps.remoteLimiter.recordFailure(REMOTE_BUCKET);
      deps.log.warn({ ip }, 'failed pairing attempt');
      throw httpError(401, 'INVALID_CODE', 'Invalid pairing code.');
    }
    deps.limiter.recordSuccess(ip);
    // The code is spent either way: it pairs once or asks for approval once.
    await rotateCode(deps);
    if (!remote) {
      reply.send(await issueToken(deps, body.deviceName));
      return;
    }
    const { info, pollToken } = deps.pairRequests.create(body.deviceName, ip);
    deps.log.info({ ip, request: info.id }, 'pairing request from outside the network awaits approval');
    announceRequests();
    deps.notifications.notify(
      {
        kind: 'info',
        state: 'waiting',
        title: '🔐 A new device wants to pair',
        body: `${info.deviceName} · ${info.ip} · check number ${info.checkCode}. Open AgentDeck to allow or deny.`,
      },
      { urgent: true },
    );
    const pending: PairPendingResponse = {
      pending: { id: info.id, pollToken, checkCode: info.checkCode, expiresAt: info.expiresAt },
    };
    reply.code(202).send(pending);
  });

  // Public like /pair: the waiting device has no token yet, the poll token is its credential.
  fastify.post('/pair/status', async (req): Promise<PairStatusResponse> => {
    const body = PairStatusSchema.parse(req.body);
    const result = deps.pairRequests.poll(body.id, body.pollToken);
    if (result.state !== 'approved') return { status: result.state };
    return { status: 'approved', ...(await issueToken(deps, result.deviceName ?? 'Device')) };
  });

  // Authed from here on: what a paired device needs to let another one in.
  fastify.get('/pair/code', async () => ({ code: await deps.pairing.readOrCreate() }));

  fastify.post('/pair/code', async () => ({ code: await rotateCode(deps) }));

  fastify.get('/pair/requests', async () => deps.pairRequests.list());

  fastify.post('/pair/requests/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = z.object({ approve: z.boolean() }).parse(req.body);
    if (!deps.pairRequests.decide(id, body.approve)) throw notFound('This pairing request is no longer waiting.');
    deps.log.info({ request: id, by: req.device?.deviceId, approve: body.approve }, 'pairing request decided');
    announceRequests();
    reply.code(204).send();
  });
}

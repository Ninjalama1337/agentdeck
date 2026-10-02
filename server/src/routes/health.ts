import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NAME, VERSION } from '../version.js';
import { httpError } from '../http/errors.js';
import { clientIp, isLanRequest } from '../util/ip.js';
import { signDeviceToken } from '../auth/jwt.js';
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

export async function pairRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.post('/pair', async (req, reply) => {
    const body = PairSchema.parse(req.body);
    // Behind a tunnel the socket peer is cloudflared (127.0.0.1) and the real
    // client IP is in x-forwarded-for — clientIp resolves both cases so each
    // remote client gets its own attempt bucket. Pairing itself is LAN-only:
    // a request that reached us through the tunnel is refused.
    const ip = clientIp(req);
    if (!isLanRequest(req)) {
      throw httpError(
        403,
        'FORBIDDEN',
        'Pairing only works from the local network. Join the same network as the server and use its LAN address (http://<lan-ip>:<port>) — once paired, the remote address works too.',
      );
    }
    if (deps.limiter.isBlocked(ip)) {
      throw httpError(
        429,
        'TOO_MANY_ATTEMPTS',
        'Too many failed pairing attempts. Try again in 10 minutes.',
      );
    }
    const expected = await deps.pairing.read();
    if (!expected || body.code.trim() !== expected) {
      deps.limiter.recordFailure(ip);
      deps.log.warn({ ip }, 'failed pairing attempt');
      throw httpError(401, 'INVALID_CODE', 'Invalid pairing code.');
    }
    deps.limiter.recordSuccess(ip);
    const device = await deps.store.registerDevice(body.deviceName);
    const token = await signDeviceToken(deps.jwtSecret, { deviceId: device.id, name: device.name });
    const nextCode = await deps.pairing.rotate();
    deps.log.debug({ device: device.id }, 'device paired; pairing code rotated');
    // Keep the deps snapshot fresh for anyone reading it (banner already printed).
    (deps as { pairingCode: string }).pairingCode = nextCode;
    reply.send({
      token,
      server: serverInfo(deps),
    });
  });
}

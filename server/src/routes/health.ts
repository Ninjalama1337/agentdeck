import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NAME, VERSION } from '../version.js';
import { httpError } from '../http/errors.js';
import { isLocalAddress } from '../util/net.js';
import { clientIp } from '../util/ip.js';
import { signDeviceToken } from '../auth/jwt.js';
import type { AppDeps } from './deps.js';

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
    // remote client gets its own attempt bucket. LAN/localhost peers (direct
    // or tunneled) may pair; the limiter below still applies.
    const ip = clientIp(req);
    if (!isLocalAddress(req.socket.remoteAddress)) {
      throw httpError(403, 'FORBIDDEN', 'Pairing is only possible from the LAN or localhost.');
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
      server: {
        name: deps.config.serverName,
        version: VERSION,
        host: `${deps.config.host}:${deps.config.port}`,
      },
    });
  });
}

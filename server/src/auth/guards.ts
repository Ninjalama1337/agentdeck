import type { FastifyReply, FastifyRequest } from 'fastify';
import { isLocalAddress } from '../util/net.js';
import { verifyDeviceToken } from './jwt.js';
import { httpError } from '../http/errors.js';

export interface RequestDevice {
  deviceId: string;
  name: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    device?: RequestDevice;
  }
}

export function bearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || undefined;
}

/**
 * Fastify onRequest hook enforcing device-JWT auth on every /api route except
 * the explicitly public ones (health, pair, pair/status), the bridge scope
 * (own guard) and signed-token file downloads (the HMAC token in the query IS
 * the credential; the route verifies signature, expiry and path binding).
 */
export function makeDeviceAuthHook(secretHex: string, touchDevice: (deviceId: string) => Promise<void>) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/')) return;
    if (path === '/api/health' || path === '/api/pair' || path === '/api/pair/status') return;
    if (path.startsWith('/api/bridge/')) return;
    // Routine webhooks carry their own secret in the URL.
    if (path.startsWith('/api/hooks/')) return;
    if (
      /^\/api\/projects\/[^/]+\/files\/raw$/.test(path) &&
      new URL(req.url, 'http://localhost').searchParams.has('token')
    ) {
      return;
    }
    const token = bearerToken(req);
    if (!token) {
      throw httpError(401, 'UNAUTHORIZED', 'Unauthorized');
    }
    const payload = await verifyDeviceToken(secretHex, token);
    if (!payload) {
      throw httpError(401, 'UNAUTHORIZED', 'Unauthorized');
    }
    req.device = payload;
    void touchDevice(payload.deviceId);
  };
}

/**
 * Guard for /api/bridge/*: requires the shared bridge token AND a loopback
 * caller (the MCP bridge binary runs on the same machine).
 */
export function makeBridgeGuard(bridgeToken: string) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!isLocalAddress(req.socket.remoteAddress)) {
      throw httpError(403, 'FORBIDDEN', 'Bridge is restricted to localhost');
    }
    const token = bearerToken(req);
    if (!token || token !== bridgeToken) {
      throw httpError(401, 'UNAUTHORIZED', 'Unauthorized');
    }
  };
}

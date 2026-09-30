/**
 * Notifications (inbox history + Web Push subscriptions) and voice
 * transcription routes.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { httpError } from '../http/errors.js';
import { VoiceError } from '../voice/transcribe.js';
import type { AppDeps } from './deps.js';

const KINDS = ['session-done', 'session-error', 'terminal-attention', 'team-done', 'team-error', 'info'] as const;

const SubscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(500) }),
  kinds: z.array(z.enum(KINDS)).optional(),
});

function deviceOf(req: import('fastify').FastifyRequest): string {
  const id = req.device?.deviceId;
  if (!id) throw httpError(401, 'UNAUTHORIZED', 'Unauthorized');
  return id;
}

export async function notificationRoutes(fastify: FastifyInstance, deps: AppDeps): Promise<void> {
  fastify.get('/notifications', async () => deps.notifications.recent());

  fastify.get('/push', async (req) => {
    const publicKey = deps.notifications.publicKey;
    return {
      enabled: publicKey !== undefined,
      ...(publicKey ? { publicKey } : {}),
      subscriptions: deps.notifications.subscriptionCount(deviceOf(req)),
    };
  });

  fastify.post('/push/subscribe', async (req, reply) => {
    const body = SubscribeSchema.parse(req.body);
    await deps.notifications.subscribe(deviceOf(req), body);
    reply.code(204).send();
  });

  fastify.post('/push/unsubscribe', async (req, reply) => {
    const body = z.object({ endpoint: z.string().optional() }).parse(req.body ?? {});
    await deps.notifications.unsubscribe(deviceOf(req), body.endpoint);
    reply.code(204).send();
  });

  fastify.post('/push/test', async (req) => {
    const delivered = await deps.notifications.test(deviceOf(req));
    return { delivered };
  });

  // Voice ------------------------------------------------------------------

  fastify.get('/voice', async () => deps.voice.status());

  fastify.post('/voice/transcribe', async (req) => {
    const query = z.object({ lang: z.string().max(20).optional() }).parse(req.query ?? {});
    const file = await req.file();
    if (!file) throw httpError(400, 'BAD_REQUEST', 'Multipart field "file" is required.');
    const audio = await file.toBuffer();
    if (audio.length < 200) throw httpError(400, 'BAD_REQUEST', 'Recording is empty.');
    try {
      const text = await deps.voice.transcribe(audio, file.mimetype, query.lang);
      return { text };
    } catch (err) {
      if (err instanceof VoiceError) {
        throw httpError(err.code === 'VOICE_UNAVAILABLE' ? 409 : 502, err.code, err.message);
      }
      throw err;
    }
  });
}

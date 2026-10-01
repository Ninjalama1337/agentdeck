/**
 * socket.io singleton typed with the shared WS protocol.
 * Auto-reconnects with exponential backoff (socket.io built-in).
 */
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@agentdeck/shared';
import { getApiBase, getToken } from './client';

export type DeckSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: DeckSocket | null = null;

export function getSocket(): DeckSocket | null {
  return socket;
}

export function connectSocket(): DeckSocket {
  const token = getToken();
  if (socket) {
    if (token) socket.auth = { token };
    return socket;
  }
  const base = getApiBase().replace(/\/+$/, '');
  const opts = {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 800,
    reconnectionDelayMax: 6000,
    reconnectionAttempts: Infinity,
    timeout: 12000,
  };
  socket = (base ? io(base, opts) : io(opts)) as DeckSocket;
  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  socket = null;
}

/** Emit session:interrupt with ack; rejects on timeout/offline so callers can fall back to REST. */
export function emitInterrupt(sessionId: string): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve, reject) => {
    const s = socket;
    if (!s || !s.connected) {
      reject(new Error('socket-offline'));
      return;
    }
    let settled = false;
    const timer = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('interrupt-timeout'));
      }
    }, 6000);
    s.emit('session:interrupt', { sessionId }, (result) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(result);
    });
  });
}

/**
 * socket.io gateway: JWT handshake auth, typed broadcasts, session:interrupt.
 */
import { Server, type Socket, type DefaultEventsMap } from 'socket.io';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@agentdeck/shared';
import type { Logger } from '../logging.js';
import { verifyDeviceToken } from '../auth/jwt.js';
import type { AgentManager } from '../agents/manager.js';
import type { TerminalManager } from '../term/manager.js';
import { ALL_TERMINALS_ROOM, terminalRoom } from './termStream.js';

/** Terminals one socket may watch at once — more than any screen shows. */
const MAX_WATCHED = 32;

export type DeckIo = Server<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;

export type Broadcaster = <E extends keyof ServerToClientEvents>(
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
) => void;

export interface GatewayOptions {
  httpServer: import('node:http').Server;
  secretHex: string;
  logger: Logger;
  manager: AgentManager;
  /** PTY terminals — input/resize arrive as WS events from the Code tab. */
  terminals: TerminalManager;
  /** Called when a client viewed a terminal (clears its attention flag). */
  onTerminalSeen?: (id: string) => void;
  touchDevice: (deviceId: string) => Promise<void>;
  corsOrigins: string[];
}

export function attachGateway(opts: GatewayOptions): DeckIo {
  const io: DeckIo = new Server(opts.httpServer, {
    path: '/socket.io',
    cors: { origin: opts.corsOrigins, credentials: true },
    transports: ['websocket', 'polling'],
    // Terminal output and session streams are ANSI/JSON text that shrinks
    // several times over — on mobile data that is the difference. Keystrokes
    // and other small frames stay uncompressed (no latency for them).
    perMessageDeflate: { threshold: 1024 },
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || !token) {
      next(new Error('Unauthorized'));
      return;
    }
    const payload = await verifyDeviceToken(opts.secretHex, token);
    if (!payload) {
      next(new Error('Unauthorized'));
      return;
    }
    (socket.data as SocketData).deviceId = payload.deviceId;
    void opts.touchDevice(payload.deviceId);
    next();
  });

  io.on('connection', (socket: Socket<ClientToServerEvents, ServerToClientEvents, never, SocketData>) => {
    opts.logger.debug({ deviceId: socket.data.deviceId, socketId: socket.id }, 'device connected');
    // Until the app says which terminals it shows, it gets all of them (older apps never say).
    void socket.join(ALL_TERMINALS_ROOM);
    socket.on('session:interrupt', (payload, ack) => {
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
      const ok = sessionId ? opts.manager.interrupt(sessionId, 'Interrupted from device') : false;
      ack({ ok: true, message: ok ? 'Interrupt sent' : 'No active run for this session' });
    });
    socket.on('terminal:input', (payload) => {
      if (typeof payload?.id !== 'string' || typeof payload?.data !== 'string') return;
      if (payload.data.length > 4096) return;
      opts.terminals.write(payload.id, payload.data);
    });
    socket.on('terminal:resize', (payload) => {
      if (
        typeof payload?.id !== 'string' ||
        typeof payload?.cols !== 'number' ||
        typeof payload?.rows !== 'number' ||
        !Number.isFinite(payload.cols) ||
        !Number.isFinite(payload.rows)
      ) {
        return;
      }
      const { cellWidth, cellHeight } = payload;
      const cell =
        typeof cellWidth === 'number' && typeof cellHeight === 'number' && Number.isFinite(cellWidth) && Number.isFinite(cellHeight)
          ? { width: cellWidth, height: cellHeight }
          : undefined;
      opts.terminals.resize(payload.id, payload.cols, payload.rows, cell);
    });
    socket.on('terminal:watch', (payload) => {
      const ids = Array.isArray(payload?.ids)
        ? payload.ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 64).slice(0, MAX_WATCHED)
        : null;
      if (!ids) return;
      const wanted = new Set(ids.map(terminalRoom));
      for (const room of socket.rooms) {
        if (room.startsWith('term:') && !wanted.has(room)) void socket.leave(room);
      }
      for (const room of wanted) void socket.join(room);
    });
    socket.on('terminal:seen', (payload) => {
      if (typeof payload?.id !== 'string') return;
      opts.onTerminalSeen?.(payload.id);
    });
  });

  return io;
}

/** Typed broadcast helper bound to an io instance. */
export function makeBroadcaster(io: DeckIo): Broadcaster {
  return (event, ...args) => {
    // io.emit is exactly this shape once the event key is generic.
    (io.emit as (ev: keyof ServerToClientEvents, ...payload: unknown[]) => boolean)(event, ...args);
  };
}

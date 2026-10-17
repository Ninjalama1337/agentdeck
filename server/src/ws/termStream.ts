/**
 * PTY output to the devices that show it. A TUI writes in many tiny chunks
 * (spinners, partial redraws) — each one its own WS frame is what makes a
 * phone on mobile data lag. Chunks are coalesced for a few milliseconds and
 * sent only to sockets watching that terminal (`terminal:watch`); a socket
 * that never sent a watch list (older app) still gets every terminal.
 */
import type { DeckIo } from './gateway.js';

/** Collect chunks this long after the first one — below what a person notices. */
export const COALESCE_MS = 8;
/** Flush right away once this much is pending (bulk output like `cat`). */
export const COALESCE_MAX_CHARS = 32 * 1024;
/** Room of sockets that get every terminal (no watch list yet). */
export const ALL_TERMINALS_ROOM = 'term:*';

export const terminalRoom = (id: string): string => `term:${id}`;

export interface TerminalStream {
  data(id: string, chunk: string): void;
  /** Flushes what is still pending first, so the last output arrives before the exit. */
  exit(id: string, code: number): void;
}

type Emit = (id: string, event: 'terminal:data' | 'terminal:exit', payload: { id: string; data: string } | { id: string; code: number }) => void;

export function createTerminalStream(emit: Emit, delayMs = COALESCE_MS): TerminalStream {
  const pending = new Map<string, { chunks: string[]; size: number; timer: ReturnType<typeof setTimeout> }>();

  const flush = (id: string) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    emit(id, 'terminal:data', { id, data: entry.chunks.join('') });
  };

  return {
    data(id, chunk) {
      if (!chunk) return;
      const entry = pending.get(id);
      if (entry) {
        entry.chunks.push(chunk);
        entry.size += chunk.length;
      } else {
        pending.set(id, { chunks: [chunk], size: chunk.length, timer: setTimeout(() => flush(id), delayMs) });
      }
      if ((entry?.size ?? chunk.length) >= COALESCE_MAX_CHARS) flush(id);
    },
    exit(id, code) {
      flush(id);
      emit(id, 'terminal:exit', { id, code });
    },
  };
}

/** The stream bound to socket.io rooms. */
export function ioTerminalStream(io: DeckIo): TerminalStream {
  return createTerminalStream((id, event, payload) => {
    if (event === 'terminal:data') {
      io.to([ALL_TERMINALS_ROOM, terminalRoom(id)]).emit('terminal:data', payload as { id: string; data: string });
    } else {
      // Every device drops an ended terminal from its list, watching or not.
      io.emit('terminal:exit', payload as { id: string; code: number });
    }
  });
}

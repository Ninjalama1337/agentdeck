/**
 * The Agents board (after Orca's dashboard): every chat session of every
 * project sorted into what it wants right now. Pure so the rules are testable.
 */
import type { Session } from '@agentdeck/shared';
import type { StreamDraft } from '../../store/sessionStream';

export type BoardColumn = 'needs' | 'working' | 'done' | 'idle';

/** Left to right / top to bottom; needs-you first. */
export const COLUMN_ORDER: BoardColumn[] = ['needs', 'working', 'done', 'idle'];

export const COLUMN_LABEL: Record<BoardColumn, string> = {
  needs: 'Needs you',
  working: 'Working',
  done: 'Done',
  idle: 'Idle',
};

export const COLUMN_HINT: Record<BoardColumn, string> = {
  needs: 'Waiting on a permission or a question',
  working: 'Running right now',
  done: 'Finished — take a look',
  idle: 'Quiet',
};

/** A session that changed within this window counts as "just finished". */
const RECENT_MS = 30 * 60_000;

export interface BoardCard {
  session: Session;
  column: BoardColumn;
  unread: boolean;
  /** Open questions of the session's run (0 unless it waits on the user). */
  pending: number;
}

export interface BoardInput {
  sessions: readonly Session[];
  drafts: Record<string, StreamDraft | undefined>;
  isUnread(session: Session): boolean;
  now?: number;
}

/** Open questions of the run: live draft first, else the REST snapshot. */
function pendingCount(session: Session, draft: StreamDraft | undefined): number {
  return draft ? (draft.permissions?.length ?? 0) : (session.pendingQuestions ?? 0);
}

/** Which column a session belongs in. "Needs you" always wins over "Working". */
export function boardColumn(
  session: Session,
  draft: StreamDraft | undefined,
  unread: boolean,
  now: number,
): BoardColumn {
  if (pendingCount(session, draft) > 0) return 'needs';
  if (session.status === 'running' || session.status === 'queued') return 'working';
  if (unread || session.status === 'error') return 'done';
  if (now - session.updatedAt < RECENT_MS) return 'done';
  return 'idle';
}

/** Groups every session into its column, newest first inside each. */
export function buildBoard(input: BoardInput): Record<BoardColumn, BoardCard[]> {
  const now = input.now ?? Date.now();
  const board: Record<BoardColumn, BoardCard[]> = { needs: [], working: [], done: [], idle: [] };
  for (const session of input.sessions) {
    const draft = input.drafts[session.id];
    const unread = input.isUnread(session);
    const column = boardColumn(session, draft, unread, now);
    board[column].push({ session, column, unread, pending: pendingCount(session, draft) });
  }
  for (const column of COLUMN_ORDER) {
    board[column].sort((a, b) => b.session.updatedAt - a.session.updatedAt);
  }
  return board;
}

/** Keeps the cards whose haystack contains `needle` (already lower-cased); empty needle keeps all. */
export function filterCards(cards: BoardCard[], needle: string, haystack: (card: BoardCard) => string): BoardCard[] {
  const q = needle.trim().toLowerCase();
  if (!q) return cards;
  return cards.filter((card) => haystack(card).toLowerCase().includes(q));
}

/** Counts per column, for headers and the tab badge. */
export function boardCounts(board: Record<BoardColumn, BoardCard[]>): Record<BoardColumn, number> {
  return {
    needs: board.needs.length,
    working: board.working.length,
    done: board.done.length,
    idle: board.idle.length,
  };
}

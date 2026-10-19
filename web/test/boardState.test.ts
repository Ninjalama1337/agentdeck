import { describe, expect, it } from 'vitest';
import type { Session, SessionStatus } from '@agentdeck/shared';
import {
  boardColumn,
  boardCounts,
  buildBoard,
  filterCards,
  COLUMN_ORDER,
  type BoardCard,
} from '../src/features/board/boardState';
import type { StreamDraft } from '../src/store/sessionStream';

const NOW = 1_000_000_000_000;

function session(over: Partial<Session> & { id: string; status: SessionStatus }): Session {
  return {
    projectId: 'p1',
    agentId: 'claude',
    title: `chat ${over.id}`,
    permissionMode: 'acceptEdits',
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    ...over,
  } as Session;
}

const draft = (permissions: number): StreamDraft => ({
  text: '',
  tools: [],
  ...(permissions > 0
    ? { permissions: Array.from({ length: permissions }, (_, i) => ({ id: `q${i}`, tool: 'Bash', ts: 0 })) }
    : {}),
});

describe('boardColumn', () => {
  it('puts a session that waits on the user in "needs", over anything else', () => {
    const s = session({ id: 'a', status: 'running' });
    expect(boardColumn(s, draft(1), false, NOW)).toBe('needs');
  });

  it('puts running and queued sessions in "working"', () => {
    expect(boardColumn(session({ id: 'a', status: 'running' }), undefined, false, NOW)).toBe('working');
    expect(boardColumn(session({ id: 'b', status: 'queued' }), undefined, false, NOW)).toBe('working');
  });

  it('counts unread, failed and recently finished sessions as "done"', () => {
    expect(boardColumn(session({ id: 'a', status: 'idle' }), undefined, true, NOW)).toBe('done');
    expect(boardColumn(session({ id: 'b', status: 'error' }), undefined, false, NOW)).toBe('done');
    expect(
      boardColumn(session({ id: 'c', status: 'idle', updatedAt: NOW - 60_000 }), undefined, false, NOW),
    ).toBe('done');
  });

  it('older, read, quiet sessions are "idle"', () => {
    const old = session({ id: 'a', status: 'idle', updatedAt: NOW - 2 * 60 * 60_000 });
    expect(boardColumn(old, undefined, false, NOW)).toBe('idle');
  });

  it('an empty questions list does not count as needs-you', () => {
    expect(boardColumn(session({ id: 'a', status: 'running' }), draft(0), false, NOW)).toBe('working');
  });
});

describe('buildBoard', () => {
  it('groups every session and sorts each column newest first', () => {
    const board = buildBoard({
      sessions: [
        session({ id: 'waiting', status: 'running', updatedAt: NOW - 5_000 }),
        session({ id: 'working', status: 'running', updatedAt: NOW - 1_000 }),
        session({ id: 'fresh', status: 'idle', updatedAt: NOW - 2_000 }),
        session({ id: 'quiet', status: 'idle', updatedAt: NOW - 5 * 60 * 60_000 }),
      ],
      drafts: { waiting: draft(2) },
      isUnread: (s) => false,
      now: NOW,
    });
    expect(COLUMN_ORDER.map((c) => board[c].map((k) => k.session.id))).toEqual([
      ['waiting'],
      ['working'],
      ['fresh'],
      ['quiet'],
    ]);
    expect(boardCounts(board)).toEqual({ needs: 1, working: 1, done: 1, idle: 1 });
    expect(board.needs[0]?.pending).toBe(2);
  });

  it('treats a REST pendingQuestions count like a live permission draft', () => {
    const waiting = session({ id: 'waiting', status: 'running', pendingQuestions: 2 });
    const board = buildBoard({
      sessions: [waiting],
      drafts: {},
      isUnread: () => false,
      now: NOW,
    });
    expect(board.needs.map((c) => c.session.id)).toEqual(['waiting']);
    expect(board.needs[0]?.pending).toBe(2);
    expect(board.working).toHaveLength(0);
  });

  it('filterCards matches on the given haystack, case-insensitively', () => {
    const cards: BoardCard[] = [
      { session: session({ id: 'a', status: 'idle', title: 'Fix the login' }), column: 'idle', unread: false, pending: 0 },
      { session: session({ id: 'b', status: 'idle', title: 'Write docs' }), column: 'idle', unread: false, pending: 0 },
    ];
    expect(filterCards(cards, 'LOGIN', (c) => c.session.title).map((c) => c.session.id)).toEqual(['a']);
    expect(filterCards(cards, '  ', (c) => c.session.title)).toHaveLength(2);
  });
});

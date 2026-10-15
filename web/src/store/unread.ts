/**
 * Unread state per device (after Orca's "unread state"): a chat whose agent
 * finished or failed while you were elsewhere stays highlighted until you open
 * it, and any chat or terminal can be marked unread again as a reminder.
 * Terminals that wait on you are flagged by the server already (attention);
 * the manual mark adds to that.
 */
import { create } from 'zustand';
import type { Session } from '@agentdeck/shared';

const KEY = 'agentdeck:unread';

interface UnreadData {
  /** Before this nothing counts as unread — the feature starts with a clean slate. */
  since: number;
  /** Session id → when it was last looked at. */
  viewed: Record<string, number>;
  /** Chats and terminals marked unread by hand ("session:<id>", "terminal:<id>"). */
  marked: string[];
}

function load(): UnreadData {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<UnreadData>;
      return {
        since: typeof p.since === 'number' ? p.since : Date.now(),
        viewed: p.viewed && typeof p.viewed === 'object' ? p.viewed : {},
        marked: Array.isArray(p.marked) ? p.marked.filter((m): m is string => typeof m === 'string') : [],
      };
    }
  } catch {
    /* fresh start */
  }
  return { since: Date.now(), viewed: {}, marked: [] };
}

/** Unread: marked by hand, or it changed after it was last seen and is not still working. */
export function isSessionUnread(session: Pick<Session, 'id' | 'status' | 'updatedAt'>, data: UnreadData): boolean {
  if (data.marked.includes(`session:${session.id}`)) return true;
  if (session.status === 'running' || session.status === 'queued') return false;
  return session.updatedAt > Math.max(data.since, data.viewed[session.id] ?? 0);
}

interface UnreadStore extends UnreadData {
  /** The user looks at it now: read, and a hand mark is gone. */
  view(target: string, at?: number): void;
  mark(target: string): void;
}

export const useUnread = create<UnreadStore>()((set, get) => {
  const save = (): void => {
    const { since, viewed, marked } = get();
    // Old entries go: only the last 300 sessions matter.
    const recent = Object.entries(viewed).sort((a, b) => b[1] - a[1]).slice(0, 300);
    try {
      localStorage.setItem(KEY, JSON.stringify({ since, viewed: Object.fromEntries(recent), marked }));
    } catch {
      /* storage unavailable */
    }
  };
  return {
    ...load(),
    view(target, at = Date.now()) {
      const { viewed, marked } = get();
      const sessionId = target.startsWith('session:') ? target.slice('session:'.length) : null;
      const nextMarked = marked.filter((m) => m !== target);
      if (nextMarked.length === marked.length && (!sessionId || (viewed[sessionId] ?? 0) >= at)) return;
      set({ marked: nextMarked, ...(sessionId ? { viewed: { ...viewed, [sessionId]: at } } : {}) });
      save();
    },
    mark(target) {
      if (get().marked.includes(target)) return;
      set({ marked: [...get().marked, target] });
      save();
    },
  };
});

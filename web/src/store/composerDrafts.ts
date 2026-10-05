/**
 * Unsent chat input per session — text and already uploaded attachments. Kept
 * in localStorage so it survives leaving the chat, switching tabs and Android
 * closing the app in the background.
 */
import type { Attachment } from '@agentdeck/shared';

export interface ComposerDraft {
  text: string;
  attachments: Attachment[];
}

const KEY = 'agentdeck:composer-drafts';
/** Oldest drafts beyond this are dropped. */
const MAX_SESSIONS = 40;
const MAX_CHARS = 20_000;

type Stored = Record<string, ComposerDraft & { ts: number }>;

let cache: Stored | null = null;

function all(): Stored {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Stored) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all()));
  } catch {
    /* storage unavailable — the draft still lives for this page load */
  }
}

export function loadComposerDraft(sessionId: string): ComposerDraft {
  const hit = all()[sessionId];
  return {
    text: typeof hit?.text === 'string' ? hit.text : '',
    attachments: Array.isArray(hit?.attachments) ? hit.attachments : [],
  };
}

/** Stores the draft; an empty one is removed. */
export function saveComposerDraft(sessionId: string, draft: ComposerDraft): void {
  const drafts = all();
  if (!draft.text && draft.attachments.length === 0) {
    if (!(sessionId in drafts)) return;
    delete drafts[sessionId];
  } else {
    drafts[sessionId] = { text: draft.text.slice(0, MAX_CHARS), attachments: draft.attachments, ts: Date.now() };
    const ids = Object.keys(drafts);
    if (ids.length > MAX_SESSIONS) {
      ids.sort((a, b) => (drafts[a]?.ts ?? 0) - (drafts[b]?.ts ?? 0));
      for (const id of ids.slice(0, ids.length - MAX_SESSIONS)) delete drafts[id];
    }
  }
  persist();
}

/**
 * The live answer of a running session as the chat shows it, and how stream
 * events and server snapshots turn into it. Pure logic — appStore wires it to
 * the socket and the REST calls.
 */
import type { AgentEvent, ChatMessage, MessageUsage, SessionDraft } from '@agentdeck/shared';

export interface ToolCard {
  id: number;
  tool: string;
  state: 'running' | 'done' | 'error';
  summary?: string;
}

export interface StreamDraft {
  text: string;
  /** Model reasoning stream — rendered separately from the answer. */
  thinking?: string;
  tools: ToolCard[];
  usage?: MessageUsage;
}

/** Which events of a run a draft already contains (from the server snapshot). */
export interface StreamMark {
  run: string;
  seq: number;
}

let toolSeq = 0;

/** True for an event the snapshot behind `mark` already includes — applying it again would double the text. */
export function isCovered(mark: StreamMark | undefined, run: string | undefined, seq: number | undefined): boolean {
  return mark !== undefined && run === mark.run && seq !== undefined && seq <= mark.seq;
}

/** Applies one stream event to a draft. Returns the draft unchanged when the event does not concern it. */
export function reduceDraft(draft: StreamDraft | undefined, event: AgentEvent): StreamDraft | undefined {
  switch (event.type) {
    case 'text-delta': {
      const base = draft ?? { text: '', tools: [] };
      return { ...base, text: base.text + event.text };
    }
    case 'thinking-delta': {
      const base = draft ?? { text: '', tools: [] };
      return { ...base, thinking: (base.thinking ?? '') + event.text };
    }
    case 'tool-use': {
      const base = draft ?? { text: '', tools: [] };
      const card: ToolCard = { id: ++toolSeq, tool: event.tool, state: 'running', summary: event.summary };
      return { ...base, tools: [...base.tools, card] };
    }
    case 'tool-result': {
      if (!draft) return draft;
      const state = event.ok ? ('done' as const) : ('error' as const);
      // The result belongs to the latest call of that tool still running.
      let open = -1;
      for (let i = draft.tools.length - 1; i >= 0; i--) {
        const t = draft.tools[i];
        if (t && t.tool === event.tool && t.state === 'running') {
          open = i;
          break;
        }
      }
      const tools =
        open >= 0
          ? draft.tools.map((t, i) => (i === open ? { ...t, state, summary: event.summary ?? t.summary } : t))
          : [...draft.tools, { id: ++toolSeq, tool: event.tool, state, summary: event.summary }];
      return { ...draft, tools };
    }
    case 'usage': {
      if (!draft) return draft;
      return {
        ...draft,
        usage: { inputTokens: event.inputTokens, outputTokens: event.outputTokens, costUsd: event.costUsd },
      };
    }
    default:
      return draft;
  }
}

/** The draft a client shows when it joins a run that is already under way. */
export function draftFromSnapshot(snap: SessionDraft): StreamDraft {
  return {
    text: snap.text,
    ...(snap.thinking ? { thinking: snap.thinking } : {}),
    tools: snap.tools.map((t) => ({ id: ++toolSeq, ...t })),
    ...(snap.usage ? { usage: snap.usage } : {}),
  };
}

/** Messages shown before the server confirmed them carry a `tmp-` id. */
export function isLocalMessage(message: ChatMessage): boolean {
  return message.id.startsWith('tmp-');
}

/** Id of the newest message the server knows — what an incremental reload asks from. */
export function lastServerMessageId(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && !isLocalMessage(m)) return m.id;
  }
  return undefined;
}

/**
 * History after a (re)load. `partial`: `incoming` holds only what is newer
 * than the local list; otherwise it replaces it. A message still on its way
 * to the server stays until its confirmed copy arrives.
 */
export function mergeHistory(local: ChatMessage[], incoming: ChatMessage[], partial: boolean): ChatMessage[] {
  const localIds = new Set(local.map((m) => m.id));
  const fresh = incoming.filter((m) => !localIds.has(m.id));
  const confirmed = partial ? [...local.filter((m) => !isLocalMessage(m)), ...fresh] : incoming;
  const waiting = local.filter(
    (m) => isLocalMessage(m) && !fresh.some((r) => r.role === 'user' && r.text === m.text),
  );
  return [...confirmed, ...waiting];
}

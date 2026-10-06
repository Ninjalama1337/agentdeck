/**
 * What one turn of a Claude Code TUI used, read from the session transcript
 * (`~/.claude/projects/<dir>/<session>.jsonl`) its Stop hook points to. The
 * TUI itself reports no usage; the transcript holds it per assistant message.
 */
import fsp from 'node:fs/promises';
import type { MessageUsage } from '@agentdeck/shared';

/** A turn's messages sit at the end of the file — a long session is not read whole. */
const TAIL_BYTES = 16 * 1024 * 1024;

export interface TranscriptTurn extends MessageUsage {
  model?: string;
  toolCalls: number;
}

interface TranscriptLine {
  type?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: {
    id?: string;
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

/** Sums the assistant messages written at or after `since` (ms). Undefined when the file tells nothing. */
export async function readClaudeTurn(transcriptPath: string, since: number): Promise<TranscriptTurn | undefined> {
  let text: string;
  try {
    const handle = await fsp.open(transcriptPath, 'r');
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      text = buffer.toString('utf8');
      // A tail starts mid-line.
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
  return sumTranscript(text, since);
}

export function sumTranscript(text: string, since: number): TranscriptTurn | undefined {
  // One message spans several lines (one per content block) that repeat its
  // usage — the last line of a message has the final numbers.
  const messages = new Map<string, NonNullable<TranscriptLine['message']>>();
  const tools = new Set<string>();
  for (const raw of text.split('\n')) {
    if (!raw.includes('"assistant"')) continue;
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw) as TranscriptLine;
    } catch {
      continue;
    }
    if (line.type !== 'assistant' || !line.message?.id) continue;
    const ts = line.timestamp ? Date.parse(line.timestamp) : NaN;
    if (!Number.isFinite(ts) || ts < since) continue;
    messages.set(line.message.id, line.message);
    if (Array.isArray(line.message.content)) {
      for (const block of line.message.content as { type?: string; id?: string }[]) {
        if (block?.type === 'tool_use' && typeof block.id === 'string') tools.add(block.id);
      }
    }
  }
  if (messages.size === 0) return undefined;
  const turn: TranscriptTurn = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: tools.size };
  const outputByModel = new Map<string, number>();
  for (const message of messages.values()) {
    const usage = message.usage ?? {};
    turn.inputTokens = (turn.inputTokens ?? 0) + (usage.input_tokens ?? 0);
    turn.outputTokens = (turn.outputTokens ?? 0) + (usage.output_tokens ?? 0);
    turn.cacheReadTokens = (turn.cacheReadTokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    turn.cacheWriteTokens = (turn.cacheWriteTokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    if (message.model) outputByModel.set(message.model, (outputByModel.get(message.model) ?? 0) + (usage.output_tokens ?? 0));
  }
  const main = [...outputByModel.entries()].sort((a, b) => b[1] - a[1])[0];
  if (main) turn.model = main[0];
  return turn;
}

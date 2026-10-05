import { describe, expect, it } from 'vitest';
import type { AgentEvent, ChatMessage } from '@agentdeck/shared';
import {
  draftFromSnapshot,
  isCovered,
  lastServerMessageId,
  mergeHistory,
  reduceDraft,
  type StreamDraft,
} from '../src/store/sessionStream';

function msg(id: string, role: ChatMessage['role'], text: string, ts = 1): ChatMessage {
  return { id, sessionId: 's1', role, text, attachments: [], ts };
}

function play(events: AgentEvent[], from?: StreamDraft): StreamDraft | undefined {
  return events.reduce<StreamDraft | undefined>((draft, event) => reduceDraft(draft, event), from);
}

describe('reduceDraft', () => {
  it('builds the live answer from the stream', () => {
    const draft = play([
      { type: 'thinking-delta', text: 'hm' },
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'tool-use', tool: 'Bash', summary: 'ls' },
      { type: 'tool-use', tool: 'Bash', summary: 'pwd' },
      { type: 'tool-result', tool: 'Bash', ok: false, summary: 'denied' },
      { type: 'usage', inputTokens: 5, outputTokens: 7 },
    ]);
    expect(draft).toMatchObject({ text: 'Hello', thinking: 'hm', usage: { inputTokens: 5, outputTokens: 7 } });
    // The result closes the latest call of that tool still open.
    expect(draft?.tools.map((t) => [t.tool, t.state, t.summary])).toEqual([
      ['Bash', 'running', 'ls'],
      ['Bash', 'error', 'denied'],
    ]);
  });

  it('does not start a draft from events that only complete one', () => {
    expect(reduceDraft(undefined, { type: 'tool-result', tool: 'Bash', ok: true })).toBeUndefined();
    expect(reduceDraft(undefined, { type: 'usage', inputTokens: 1 })).toBeUndefined();
    expect(reduceDraft(undefined, { type: 'raw', line: 'x' })).toBeUndefined();
  });
});

describe('joining a run that is under way', () => {
  const snapshot = {
    run: 'run_a',
    seq: 12,
    text: 'First part. ',
    thinking: 'plan',
    tools: [{ tool: 'Read', state: 'done' as const, summary: 'a.ts' }, { tool: 'Bash', state: 'running' as const }],
  };

  it('continues exactly where the snapshot ends', () => {
    const mark = { run: snapshot.run, seq: snapshot.seq };
    const stream: { run: string; seq: number; event: AgentEvent }[] = [
      // Sent before the snapshot was taken, delivered after it — already included.
      { run: 'run_a', seq: 11, event: { type: 'text-delta', text: 'First part. ' } },
      { run: 'run_a', seq: 12, event: { type: 'tool-use', tool: 'Bash' } },
      { run: 'run_a', seq: 13, event: { type: 'tool-result', tool: 'Bash', ok: true } },
      { run: 'run_a', seq: 14, event: { type: 'text-delta', text: 'Second part.' } },
    ];
    const draft = stream
      .filter((p) => !isCovered(mark, p.run, p.seq))
      .reduce<StreamDraft | undefined>((d, p) => reduceDraft(d, p.event), draftFromSnapshot(snapshot));
    expect(draft?.text).toBe('First part. Second part.');
    expect(draft?.thinking).toBe('plan');
    expect(draft?.tools.map((t) => [t.tool, t.state])).toEqual([
      ['Read', 'done'],
      ['Bash', 'done'],
    ]);
  });

  it('lets everything through that the snapshot cannot contain', () => {
    const mark = { run: 'run_a', seq: 12 };
    expect(isCovered(mark, 'run_a', 12)).toBe(true);
    expect(isCovered(mark, 'run_a', 13)).toBe(false);
    // The next run counts from 1 again.
    expect(isCovered(mark, 'run_b', 1)).toBe(false);
    // Events outside a run (final status, stored message) and older servers carry no counter.
    expect(isCovered(mark, undefined, undefined)).toBe(false);
    expect(isCovered(undefined, 'run_a', 1)).toBe(false);
  });
});

describe('mergeHistory', () => {
  const history = [msg('m_1', 'user', 'hi'), msg('m_2', 'assistant', 'hello')];

  it('appends what is new to the history already shown', () => {
    const merged = mergeHistory(history, [msg('m_3', 'user', 'more'), msg('m_4', 'assistant', 'sure')], true);
    expect(merged.map((m) => m.id)).toEqual(['m_1', 'm_2', 'm_3', 'm_4']);
  });

  it('replaces the list on a full reload', () => {
    const merged = mergeHistory([msg('m_old', 'user', 'stale')], history, false);
    expect(merged.map((m) => m.id)).toEqual(['m_1', 'm_2']);
  });

  it('does not double a message that arrived over the socket meanwhile', () => {
    const merged = mergeHistory([...history, msg('m_3', 'user', 'more')], [msg('m_3', 'user', 'more')], true);
    expect(merged.map((m) => m.id)).toEqual(['m_1', 'm_2', 'm_3']);
  });

  it('keeps a message that is still on its way and drops it once the server has it', () => {
    const local = [...history, msg('tmp-1', 'user', 'pending')];
    expect(mergeHistory(local, [], true).map((m) => m.id)).toEqual(['m_1', 'm_2', 'tmp-1']);
    expect(mergeHistory(local, history, false).map((m) => m.id)).toEqual(['m_1', 'm_2', 'tmp-1']);
    const confirmed = [msg('m_3', 'user', 'pending'), msg('m_4', 'assistant', 'ok')];
    expect(mergeHistory(local, confirmed, true).map((m) => m.id)).toEqual(['m_1', 'm_2', 'm_3', 'm_4']);
  });

  it('is not fooled by an older message with the same text', () => {
    const local = [msg('m_1', 'user', 'weiter'), msg('m_2', 'assistant', 'ok'), msg('tmp-1', 'user', 'weiter')];
    const merged = mergeHistory(local, [msg('m_1', 'user', 'weiter'), msg('m_2', 'assistant', 'ok')], false);
    expect(merged.map((m) => m.id)).toEqual(['m_1', 'm_2', 'tmp-1']);
  });

  it('asks for what follows the newest confirmed message', () => {
    expect(lastServerMessageId([...history, msg('tmp-1', 'user', 'pending')])).toBe('m_2');
    expect(lastServerMessageId([msg('tmp-1', 'user', 'pending')])).toBeUndefined();
    expect(lastServerMessageId([])).toBeUndefined();
  });
});

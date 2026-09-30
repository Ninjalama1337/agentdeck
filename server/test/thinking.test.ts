import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@agentdeck/shared';
import { ClaudeAdapter } from '../src/agents/claude.js';
import {
  applyZcodeModelSelection,
  createZcodeStreamParser,
  ZCodeAdapter,
} from '../src/agents/zcode.js';
import { CodexAdapter } from '../src/agents/codex.js';
import type { ResolvedAgentConfig } from '../src/config.js';

const claudeCfg: ResolvedAgentConfig = { mode: 'headless', command: 'claude' };
const zcodeCfg: ResolvedAgentConfig = { mode: 'headless', command: 'zcode' };
const codexCfg: ResolvedAgentConfig = { mode: 'headless', command: 'codex' };

function collect(parser: { parse(line: string, emit: (e: AgentEvent) => void): void }, lines: string[]): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const line of lines) parser.parse(line, (e) => events.push(e));
  return events;
}

describe('thinking separation — claude', () => {
  it('routes thinking blocks to thinking-delta, never into text-delta', () => {
    const adapter = new ClaudeAdapter(claudeCfg);
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me reason about the file.', signature: 'sig' },
            { type: 'text', text: 'Here is the answer.' },
          ],
        },
      }),
    ].join('\n').split('\n');
    // feed via the adapter's per-run parser (buildRun)
    const plan = adapter.buildRun({
      session: {
        id: 's1', projectId: 'p1', agentId: 'claude', title: 't', status: 'idle',
        permissionMode: 'default', createdAt: 0, updatedAt: 0,
      },
      project: { id: 'p1', name: 'demo', path: '/tmp/x', createdAt: 0, updatedAt: 0 },
      text: 'hi',
      attachments: [],
    } as Parameters<typeof adapter.buildRun>[0]);
    const events = collect({ parse: plan.parse }, lines);
    const thinking = events.filter((e) => e.type === 'thinking-delta');
    const text = events.filter((e) => e.type === 'text-delta');
    expect(thinking).toHaveLength(1);
    expect((thinking[0] as { text: string }).text).toBe('Let me reason about the file.');
    expect(text).toHaveLength(1);
    expect((text[0] as { text: string }).text).toBe('Here is the answer.');
  });
});

describe('thinking separation — zcode', () => {
  it('splits model_streaming by kind: reasoning_delta → thinking, text_delta → answer', () => {
    const events = collect(createZcodeStreamParser(), [
      JSON.stringify({ type: 'model.streaming', payload: { kind: 'start', delta: '' } }),
      JSON.stringify({ type: 'model.streaming', payload: { kind: 'reasoning_start', delta: '' } }),
      JSON.stringify({ type: 'model.streaming', payload: { kind: 'reasoning_delta', delta: 'The user said "Hey". I should greet back.' } }),
      JSON.stringify({ type: 'model.streaming', payload: { kind: 'reasoning_end', delta: '' } }),
      JSON.stringify({ type: 'model.streaming', payload: { kind: 'text_start', delta: '' } }),
      JSON.stringify({ type: 'model.streaming', payload: { kind: 'text_delta', delta: 'Hello!' } }),
      JSON.stringify({ type: 'model.streaming', payload: { kind: 'text_end', delta: '' } }),
      JSON.stringify({ type: 'model.streaming', payload: { kind: 'finish', delta: '' } }),
    ]);
    const thinking = events
      .filter((e) => e.type === 'thinking-delta')
      .map((e) => (e.type === 'thinking-delta' ? e.text : ''))
      .join('');
    const text = events
      .filter((e) => e.type === 'text-delta')
      .map((e) => (e.type === 'text-delta' ? e.text : ''))
      .join('');
    expect(thinking).toBe('The user said "Hey". I should greet back.');
    expect(text).toBe('Hello!');
  });

  it('also handles standalone reasoning events', () => {
    const events = collect(createZcodeStreamParser(), [
      JSON.stringify({ type: 'reasoning.delta', payload: { reasoning: { text: 'plan the change' } } }),
      JSON.stringify({ type: 'model.streaming', payload: { kind: 'text_delta', delta: 'the answer' } }),
    ]);
    expect(events.find((e) => e.type === 'thinking-delta')).toMatchObject({ text: 'plan the change' });
  });

  it('kindless streaming deltas stay answer text (legacy tolerance)', () => {
    const events = collect(createZcodeStreamParser(), [
      JSON.stringify({ type: 'model.streaming', payload: { delta: 'plain answer' } }),
    ]);
    expect(events.find((e) => e.type === 'text-delta')).toBeUndefined(); // only text_delta kind counts now
  });

  it('exposes GLM efforts', () => {
    expect(new ZCodeAdapter(zcodeCfg).efforts).toEqual(['default', 'low', 'medium', 'high']);
  });
});

describe('applyZcodeModelSelection (provider config patch)', () => {
  it('patches model + reasoning level atomically and preserves providerId', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zcode-prov-'));
    const file = path.join(dir, 'provider_config.json');
    await fsp.writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        config: {},
        defaultModelSelection: { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3' },
      }),
      'utf8',
    );
    applyZcodeModelSelection({ modelId: 'GLM-5.3-Flash', reasoningLevel: 'high' }, file);
    const after = JSON.parse(await fsp.readFile(file, 'utf8')) as {
      defaultModelSelection: { providerId: string; modelId: string; options?: { reasoningLevel?: string } };
    };
    expect(after.defaultModelSelection.providerId).toBe('account:zai-individual-coding-plan');
    expect(after.defaultModelSelection.modelId).toBe('GLM-5.3-Flash');
    expect(after.defaultModelSelection.options?.reasoningLevel).toBe('high');

    // clearing the level removes the options key
    applyZcodeModelSelection({ modelId: 'GLM-5.2' }, file);
    const cleared = JSON.parse(await fsp.readFile(file, 'utf8')) as {
      defaultModelSelection: { options?: { reasoningLevel?: string } };
    };
    expect(cleared.defaultModelSelection.options?.reasoningLevel).toBeUndefined();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('codex reasoning summaries go to thinking-delta', () => {
    const adapter = new CodexAdapter(codexCfg);
    const plan = adapter.buildRun({
      session: {
        id: 's1', projectId: 'p1', agentId: 'codex', title: 't', status: 'idle',
        permissionMode: 'default', createdAt: 0, updatedAt: 0,
      },
      project: { id: 'p1', name: 'demo', path: '/tmp/x', createdAt: 0, updatedAt: 0 },
      text: 'hi',
      attachments: [],
    } as Parameters<typeof adapter.buildRun>[0]);
    const events = collect({ parse: plan.parse }, [
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Considering options.' }] },
      }),
    ]);
    const thinking = events.find((e) => e.type === 'thinking-delta');
    expect(thinking).toMatchObject({ type: 'thinking-delta', text: 'Considering options.' });
  });
});

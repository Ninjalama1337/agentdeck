import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { nextMermaidId } from '../src/components/ui/Mermaid';
import { mermaidSource } from '../src/components/ui/Markdown';

const code = (className: string, text: string) => createElement('code', { className }, text);

describe('mermaidSource', () => {
  it('reads the chart out of a fenced mermaid code block', () => {
    const chart = 'graph TD;\n  A-->B;';
    expect(mermaidSource(code('language-mermaid', chart))).toBe(chart);
  });

  it('ignores other languages and non-elements', () => {
    expect(mermaidSource(code('language-ts', 'const a = 1;'))).toBeUndefined();
    expect(mermaidSource('plain text')).toBeUndefined();
    // Several children: only the mermaid block counts.
    expect(
      mermaidSource([code('language-ts', 'const a = 1;'), code('language-mermaid', 'flowchart LR')]),
    ).toBe('flowchart LR');
  });
});

describe('nextMermaidId', () => {
  it('returns a fresh id for every render', () => {
    const ids = [nextMermaidId(), nextMermaidId(), nextMermaidId()];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^ad-mermaid-\d+$/);
  });
});

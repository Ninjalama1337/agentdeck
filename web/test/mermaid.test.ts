import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
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

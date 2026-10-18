import { describe, expect, it } from 'vitest';
import { asDesignPick, designPrompt, pickSummary, withDesignPick, type DesignPick } from '../src/features/design/designPick';

const payload = {
  selector: 'main > section:nth-of-type(2) > button.cta.primary',
  tag: 'button',
  id: '',
  classes: 'cta primary',
  text: 'Deploy',
  html: '<button class="cta primary">Deploy</button>',
  styles: { display: 'flex', 'background-color': '#7C5CFF', 'padding': '8px 16px' },
  rect: { x: 24, y: 320, width: 180, height: 44 },
  parent: 'section.hero 340x120',
  url: '/dashboard?tab=live',
  viewport: { width: 412, height: 915 },
  scale: 2,
};

describe('asDesignPick', () => {
  it('accepts a bridge payload and normalizes it', () => {
    const pick = asDesignPick(payload);
    expect(pick).toBeDefined();
    expect(pick?.selector).toBe(payload.selector);
    expect(pick?.tag).toBe('button');
    expect(pick?.classes).toBe('cta primary');
    expect(pick?.rect).toEqual({ x: 24, y: 320, width: 180, height: 44 });
    expect(pick?.viewport).toEqual({ width: 412, height: 915 });
    expect(pick?.styles).toEqual({ display: 'flex', 'background-color': '#7C5CFF', padding: '8px 16px' });
    // Empty id is dropped instead of kept as an empty string.
    expect(pick?.id).toBeUndefined();
  });

  it('rejects what is not a pick and drops junk styles', () => {
    expect(asDesignPick(null)).toBeUndefined();
    expect(asDesignPick('nope')).toBeUndefined();
    expect(asDesignPick({})).toBeUndefined();
    expect(asDesignPick({ selector: '' })).toBeUndefined();
    const pick = asDesignPick({ selector: 'div', styles: { ok: 'x', bad: 42, '': 'y' } });
    expect(pick?.styles).toEqual({ ok: 'x' });
    expect(pick?.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(pick?.truncated).toBe(false);
  });

  it('caps long fields so an untrusted page cannot flood the composer', () => {
    const pick = asDesignPick({ selector: 'd'.repeat(1000), html: 'x'.repeat(20000) });
    expect(pick?.selector).toHaveLength(400);
    expect(pick?.html.length).toBeLessThanOrEqual(8000);
  });
});

describe('designPrompt', () => {
  const pick = asDesignPick(payload) as DesignPick;

  it('carries page, selector, box, html and styles', () => {
    const text = designPrompt(pick, 'localhost:5174');
    expect(text).toContain('preview on localhost:5174');
    expect(text).toContain('- Page: /dashboard?tab=live');
    expect(text).toContain('- Selector: main > section:nth-of-type(2) > button.cta.primary');
    expect(text).toContain('- Box: 180×44 at (24, 320)');
    expect(text).toContain('<button class="cta primary">Deploy</button>');
    expect(text).toContain('background-color: #7C5CFF;');
    expect(text).toContain('What should change here?');
  });

  it('mentions truncation and handily skips a missing text', () => {
    const text = designPrompt({ ...pick, truncated: true, text: undefined }, '');
    expect(text).toContain('HTML (truncated):');
    expect(text).not.toContain('- Text:');
  });
});

describe('withDesignPick', () => {
  const pick = asDesignPick(payload) as DesignPick;

  it('appends to what is already typed', () => {
    const merged = withDesignPick('Make it rounder', pick, 'h:1');
    expect(merged.startsWith('Make it rounder\n\n')).toBe(true);
    expect(merged).toContain('- Selector:');
  });

  it('uses the block alone when the field is empty', () => {
    expect(withDesignPick('   ', pick, 'h:1').startsWith('I picked this element')).toBe(true);
  });
});

describe('pickSummary', () => {
  it('names the tag with its first classes and the box', () => {
    expect(pickSummary(asDesignPick(payload) as DesignPick)).toBe('button.cta.primary · 180×44');
    expect(pickSummary(asDesignPick({ selector: 'div', tag: 'div', rect: payload.rect }) as DesignPick)).toBe('div · 180×44');
  });
});

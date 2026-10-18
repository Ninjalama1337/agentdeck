/**
 * What the design-mode bridge sends when an element is picked, and how it turns
 * into a prompt for the agent. The payload arrives over postMessage from a
 * dev-server page, so it is untrusted: everything is validated and capped here.
 */

export const DESIGN_SOURCE = 'agentdeck-design';
export const DESIGN_HOST_SOURCE = 'agentdeck-design-host';

export interface DesignRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesignPick {
  selector: string;
  tag: string;
  id?: string;
  classes?: string;
  text?: string;
  html: string;
  truncated: boolean;
  styles: Record<string, string>;
  rect: DesignRect;
  parent?: string;
  url: string;
  viewport: { width: number; height: number };
  scale: number;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined;
}

function rectOf(value: unknown): DesignRect | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const num = (k: string) => (typeof raw[k] === 'number' && Number.isFinite(raw[k]) ? Math.round(raw[k] as number) : 0);
  return { x: num('x'), y: num('y'), width: num('width'), height: num('height') };
}

/** Validates a postMessage payload; undefined when it is not a usable pick. */
export function asDesignPick(value: unknown): DesignPick | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const selector = text(raw['selector'], 400);
  if (!selector) return undefined;
  const html = typeof raw['html'] === 'string' ? raw['html'].slice(0, 8000) : '';

  const styles: Record<string, string> = {};
  if (raw['styles'] && typeof raw['styles'] === 'object') {
    for (const [key, val] of Object.entries(raw['styles'] as Record<string, unknown>)) {
      if (Object.keys(styles).length >= 60) break;
      const name = text(key, 40);
      const value2 = text(val, 300);
      if (name && value2) styles[name] = value2;
    }
  }

  const viewportRaw = rectOf(raw['viewport']);
  return {
    selector,
    tag: text(raw['tag'], 40) ?? 'element',
    ...(text(raw['id'], 120) ? { id: text(raw['id'], 120) as string } : {}),
    ...(text(raw['classes'], 200) ? { classes: text(raw['classes'], 200) as string } : {}),
    ...(text(raw['text'], 400) ? { text: text(raw['text'], 400) as string } : {}),
    html,
    truncated: raw['truncated'] === true,
    styles,
    rect: rectOf(raw['rect']) ?? { x: 0, y: 0, width: 0, height: 0 },
    ...(text(raw['parent'], 160) ? { parent: text(raw['parent'], 160) as string } : {}),
    url: text(raw['url'], 500) ?? '/',
    viewport: { width: viewportRaw?.width ?? 0, height: viewportRaw?.height ?? 0 },
    scale: typeof raw['scale'] === 'number' && Number.isFinite(raw['scale']) ? raw['scale'] : 1,
  };
}

/** One-line label for the pick card ("button.cta · 180×44"). */
export function pickSummary(pick: DesignPick): string {
  const name = pick.classes ? `${pick.tag}.${pick.classes.split(/\s+/).slice(0, 2).join('.')}` : pick.tag;
  return `${name} · ${pick.rect.width}×${pick.rect.height}`;
}

/**
 * The block the pick turns into. Goes into the composer (appended to whatever
 * is typed there), so the agent gets the element, its markup and the styles
 * that actually apply — the same context a devtools inspector would show.
 */
export function designPrompt(pick: DesignPick, origin: string): string {
  const lines: string[] = [];
  lines.push('I picked this element in the live preview of the running app:', '');
  lines.push(`- Page: ${pick.url}${origin ? ` (preview on ${origin})` : ''}`);
  lines.push(`- Selector: ${pick.selector}`);
  if (pick.parent) lines.push(`- Parent: ${pick.parent}`);
  lines.push(
    `- Box: ${pick.rect.width}×${pick.rect.height} at (${pick.rect.x}, ${pick.rect.y}) — viewport ${pick.viewport.width}×${pick.viewport.height}`,
  );
  if (pick.text) lines.push(`- Text: ${pick.text.replace(/\s+/g, ' ')}`);

  lines.push('', `HTML${pick.truncated ? ' (truncated)' : ''}:`, '```html', pick.html || '(empty)', '```');

  const styles = Object.entries(pick.styles);
  if (styles.length > 0) {
    lines.push('', `Styles that differ from the browser default for <${pick.tag}>:`, '```css');
    for (const [name, value] of styles) lines.push(`${name}: ${value};`);
    lines.push('```');
  }
  lines.push('', 'What should change here?');
  return lines.join('\n');
}

/** Composer text after a pick: append to what is already typed instead of replacing it. */
export function withDesignPick(existing: string, pick: DesignPick, origin: string): string {
  const block = designPrompt(pick, origin);
  return existing.trim() ? `${existing.replace(/\s+$/, '')}\n\n${block}` : block;
}

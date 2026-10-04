/**
 * Separates inline reasoning (`<think>…</think>`, `<thinking>`, `<reasoning>`,
 * `<thought>`) from answer text. Many models (GLM, DeepSeek, Qwen, …) emit their
 * reasoning inline in the normal text channel instead of a dedicated one.
 */
const TAGS = ['think', 'thinking', 'reasoning', 'thought'];
const OPEN_RE = new RegExp(`<(${TAGS.join('|')})>`, 'i');

export interface ThinkPart {
  kind: 'text' | 'thinking';
  text: string;
}

/** Streaming splitter: feed chunks, get ordered parts. Tags split across chunks are handled. */
export class ThinkTagSplitter {
  private pending = '';
  private closeTag: string | null = null;

  push(chunk: string): ThinkPart[] {
    this.pending += chunk;
    const out: ThinkPart[] = [];
    for (;;) {
      if (this.closeTag) {
        const idx = this.pending.toLowerCase().indexOf(this.closeTag);
        if (idx >= 0) {
          emit(out, 'thinking', this.pending.slice(0, idx));
          this.pending = this.pending.slice(idx + this.closeTag.length).replace(/^\n+/, '');
          this.closeTag = null;
          continue;
        }
        const keep = partialSuffix(this.pending, this.closeTag);
        emit(out, 'thinking', this.pending.slice(0, this.pending.length - keep));
        this.pending = this.pending.slice(this.pending.length - keep);
        break;
      }
      const m = OPEN_RE.exec(this.pending);
      if (m) {
        emit(out, 'text', this.pending.slice(0, m.index));
        this.closeTag = `</${m[1]!.toLowerCase()}>`;
        this.pending = this.pending.slice(m.index + m[0].length).replace(/^\n+/, '');
        continue;
      }
      const keep = Math.max(...TAGS.map((t) => partialSuffix(this.pending, `<${t}>`)));
      emit(out, 'text', this.pending.slice(0, this.pending.length - keep));
      this.pending = this.pending.slice(this.pending.length - keep);
      break;
    }
    return out;
  }

  /** Flush whatever is held back (an unfinished tag prefix, or reasoning without a close tag). */
  end(): ThinkPart[] {
    const out: ThinkPart[] = [];
    emit(out, this.closeTag ? 'thinking' : 'text', this.pending);
    this.pending = '';
    this.closeTag = null;
    return out;
  }
}

/** One-shot split for already persisted messages. */
export function splitThinkTags(text: string): { text: string; thinking: string } {
  const splitter = new ThinkTagSplitter();
  const parts = [...splitter.push(text), ...splitter.end()];
  const answer = parts.filter((p) => p.kind === 'text').map((p) => p.text).join('');
  const thinking = parts.filter((p) => p.kind === 'thinking').map((p) => p.text).join('\n\n');
  return { text: answer, thinking };
}

function emit(out: ThinkPart[], kind: ThinkPart['kind'], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += text;
  else out.push({ kind, text });
}

/** Length of the longest suffix of `s` that is a proper prefix of `tag` (case-insensitive). */
function partialSuffix(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  const lower = s.toLowerCase();
  for (let n = max; n > 0; n--) {
    if (tag.startsWith(lower.slice(lower.length - n))) return n;
  }
  return 0;
}

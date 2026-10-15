/**
 * Review comments on a diff (after Orca's "annotate AI diffs"): tap a line in
 * the Git tab's diff, write what should change, collect comments across files,
 * then send them to an agent as one prompt. Comments live per project on this
 * device until they are sent or cleared.
 */
import { create } from 'zustand';

export type DiffLineKind = 'add' | 'del' | 'context' | 'hunk' | 'meta';

export interface DiffLineRef {
  kind: DiffLineKind;
  /** File the line belongs to (new path; old path for deletions of a whole file). */
  file?: string;
  /** Line number in the new file (add / context). */
  newLine?: number;
  /** Line number in the old file (del / context). */
  oldLine?: number;
}

function stripPrefix(path: string): string | undefined {
  if (path === '/dev/null') return undefined;
  return path.replace(/^[ab]\//, '');
}

/** File and line numbers for every line of a unified diff. */
export function diffLineRefs(lines: string[]): DiffLineRef[] {
  const refs: DiffLineRef[] = [];
  let file: string | undefined;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith('diff ')) {
      inHunk = false;
      // "diff --git a/x b/x" — the b side, until +++ says otherwise.
      const m = / b\/(.+)$/.exec(line);
      file = m ? m[1] : undefined;
      refs.push({ kind: 'meta' });
    } else if (!inHunk && line.startsWith('--- ')) {
      file = stripPrefix(line.slice(4).trim()) ?? file;
      refs.push({ kind: 'meta' });
    } else if (!inHunk && line.startsWith('+++ ')) {
      file = stripPrefix(line.slice(4).trim()) ?? file;
      refs.push({ kind: 'meta' });
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      inHunk = m !== null;
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      refs.push({ kind: 'hunk', file });
    } else if (inHunk && line.startsWith('+')) {
      refs.push({ kind: 'add', file, newLine: newNo++ });
    } else if (inHunk && line.startsWith('-')) {
      refs.push({ kind: 'del', file, oldLine: oldNo++ });
    } else if (inHunk && (line.startsWith(' ') || line === '')) {
      refs.push({ kind: 'context', file, oldLine: oldNo++, newLine: newNo++ });
    } else {
      // "\ No newline at end of file", index lines, binary notes
      refs.push({ kind: 'meta', file });
    }
  }
  return refs;
}

export interface ReviewComment {
  id: string;
  file: string;
  /** "42" for new/context lines, "old 17" for removed ones. */
  line: string;
  /** The diff line as shown (with its +/-/space marker). */
  code: string;
  text: string;
}

/** Where a comment attaches: "src/a.ts:42", removed lines "src/a.ts (removed line 17)". */
export function commentLocation(c: Pick<ReviewComment, 'file' | 'line'>): string {
  return c.line.startsWith('old ') ? `${c.file} (removed line ${c.line.slice(4)})` : `${c.file}:${c.line}`;
}

export function lineKey(ref: DiffLineRef): string | null {
  if (!ref.file) return null;
  if (ref.kind === 'del') return ref.oldLine !== undefined ? `old ${ref.oldLine}` : null;
  if (ref.kind === 'add' || ref.kind === 'context') return ref.newLine !== undefined ? String(ref.newLine) : null;
  return null;
}

/** The prompt the agent gets: every comment with its place and the code it is about. */
export function reviewPrompt(comments: ReviewComment[]): string {
  const ordered = [...comments].sort((a, b) => a.file.localeCompare(b.file) || lineOrder(a.line) - lineOrder(b.line));
  const parts = ordered.map((c) => {
    const code = c.code.length > 200 ? `${c.code.slice(0, 200)}…` : c.code;
    return `${commentLocation(c)}\n    ${code}\n  → ${c.text.trim().replace(/\n+/g, '\n    ')}`;
  });
  return [
    `Review comments on the current changes (${comments.length}):`,
    '',
    parts.join('\n\n'),
    '',
    'Please address each comment.',
  ].join('\n');
}

function lineOrder(line: string): number {
  return Number(line.replace(/^old /, '')) || 0;
}

interface ReviewStore {
  byProject: Record<string, ReviewComment[]>;
  add(projectId: string, comment: Omit<ReviewComment, 'id'>): void;
  update(projectId: string, id: string, text: string): void;
  remove(projectId: string, id: string): void;
  clear(projectId: string): void;
}

const KEY = 'agentdeck:review-comments';

function load(): Record<string, ReviewComment[]> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, ReviewComment[]>) : {};
  } catch {
    return {};
  }
}

function save(byProject: Record<string, ReviewComment[]>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(byProject));
  } catch {
    /* storage unavailable — comments still live for this session */
  }
}

export const useReviewComments = create<ReviewStore>()((set, get) => {
  const write = (projectId: string, list: ReviewComment[]): void => {
    const byProject = { ...get().byProject };
    if (list.length) byProject[projectId] = list;
    else delete byProject[projectId];
    set({ byProject });
    save(byProject);
  };
  return {
    byProject: load(),
    add(projectId, comment) {
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      write(projectId, [...(get().byProject[projectId] ?? []), { ...comment, id }]);
    },
    update(projectId, id, text) {
      write(projectId, (get().byProject[projectId] ?? []).map((c) => (c.id === id ? { ...c, text } : c)));
    },
    remove(projectId, id) {
      write(projectId, (get().byProject[projectId] ?? []).filter((c) => c.id !== id));
    },
    clear(projectId) {
      write(projectId, []);
    },
  };
});

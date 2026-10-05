/** Small formatting helpers shared across screens. */

export function bytes(n?: number): string {
  if (n === undefined || n === null) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function relTime(ts?: number | string): string {
  if (!ts) return '';
  const t = typeof ts === 'string' ? Date.parse(ts) : ts;
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  if (diff < 0) return relTimeFuture(t);
  const s = Math.round(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "in 5m" / "in 3h" / "tomorrow 09:00" — for scheduled fires. */
export function relTimeFuture(t: number): string {
  const diff = t - Date.now();
  const s = Math.max(0, Math.round(diff / 1000));
  if (s < 60) return 'in <1m';
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  if (h < 48) return `tomorrow ${clock(t)}`;
  const d = Math.round(h / 24);
  if (d < 7) return `${new Date(t).toLocaleDateString(undefined, { weekday: 'short' })} ${clock(t)}`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

/** Reset time from the server: an ISO instant shows in the device's timezone, provider text is kept. */
export function resetLabel(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) return normalizeMeridiemTimes(value);
  const t = Date.parse(value);
  if (Number.isNaN(t)) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(t));
}

/** Converts provider text such as "1:19pm" to a 24-hour clock for display. */
export function normalizeMeridiemTimes(text: string): string {
  return text.replace(
    /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*([ap])m\b/gi,
    (_match, hour: string, minute: string | undefined, period: string) => {
      const hour24 = (Number(hour) % 12) + (period.toLowerCase() === 'p' ? 12 : 0);
      return `${String(hour24).padStart(2, '0')}${minute === undefined ? '' : `:${minute}`}`;
    },
  );
}

/** Compact elapsed duration ("42s", "3m", "1h 05m") for running jobs. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function cost(usd?: number): string {
  if (usd === undefined) return '';
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

export function tokens(n?: number): string {
  if (n === undefined) return '';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

export function initials(label: string): string {
  const parts = label.trim().split(/\s+/).slice(0, 2);
  const out = parts.map((w) => w[0]?.toUpperCase() ?? '').join('');
  return out || 'A';
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function guessDeviceName(): string {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua)
      ? 'iOS'
      : /Mac/i.test(ua)
        ? 'macOS'
        : /Windows/i.test(ua)
          ? 'Windows'
          : /Linux/i.test(ua)
            ? 'Linux'
            : 'Device';
  const browser = /Firefox/i.test(ua)
    ? 'Firefox'
    : /Edg/i.test(ua)
      ? 'Edge'
      : /Chrome/i.test(ua)
        ? 'Chrome'
        : /Safari/i.test(ua)
          ? 'Safari'
          : 'Browser';
  return `${os} · ${browser}`;
}

const LANG_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572A5',
  Rust: '#dea584',
  Go: '#00ADD8',
  Java: '#b07219',
  'C++': '#f34b7d',
  'C#': '#178600',
  C: '#555555',
  Ruby: '#701516',
  PHP: '#4F5D95',
  Swift: '#F05138',
  Kotlin: '#A97BFF',
  Shell: '#89e051',
  HTML: '#e34c26',
  CSS: '#563d7c',
  Vue: '#41b883',
  Dart: '#00B4AB',
  Lua: '#000080',
  Zig: '#ec915c',
};

export function langColor(lang?: string | null): string {
  if (!lang) return '#98a2b8';
  return LANG_COLORS[lang] ?? '#98a2b8';
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'avif', 'ico']);
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'json5', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'log', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'css', 'scss', 'less', 'html', 'htm', 'xml',
  'svg', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh',
  'bash', 'zsh', 'fish', 'sql', 'graphql', 'gql', 'prisma', 'env', 'gitignore', 'dockerfile',
  'makefile', 'lock', 'editorconfig', 'vue', 'svelte', 'php', 'pl', 'r', 'dart',
]);
const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar']);

export type FileVisualKind = 'image' | 'text' | 'code' | 'archive' | 'file';

export function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  return ext;
}

export function fileVisualKind(name: string, kind: 'file' | 'dir'): FileVisualKind {
  if (kind === 'dir') return 'file';
  const ext = fileExt(name);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ARCHIVE_EXTS.has(ext)) return 'archive';
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'vue', 'svelte', 'dart', 'sh', 'sql', 'graphql', 'gql', 'lua', 'zig'].includes(ext))
    return 'code';
  if (TEXT_EXTS.has(ext)) return 'text';
  if (!ext && ['dockerfile', 'makefile', 'license', 'readme'].some((s) => name.toLowerCase().includes(s))) return 'text';
  return 'file';
}

export function isPreviewableText(name: string, size?: number): boolean {
  const kind = fileVisualKind(name, 'file');
  if (kind === 'image' || kind === 'archive') return false;
  if (kind === 'code' || kind === 'text') return (size ?? 0) < 2 * 1024 * 1024;
  return false;
}

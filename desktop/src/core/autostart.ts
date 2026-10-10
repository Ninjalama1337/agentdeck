import path from 'node:path';
import { writeFileAtomic, type FileSystem } from './fs';

/** Command line argument that starts the app without a window (login autostart). */
export const HIDDEN_FLAG = '--hidden';

/** Quotes one argument for the Exec= key of a desktop entry (freedesktop spec, "The Exec key"). */
export function quoteExecArg(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) && !arg.includes('%')) return arg;
  const escaped = arg
    .replace(/\\/g, '\\\\\\\\') // two levels of unescaping: string value, then Exec quoting
    .replace(/"/g, '\\\\"')
    .replace(/`/g, '\\\\`')
    .replace(/\$/g, '\\\\$')
    .replace(/%/g, '%%');
  return `"${escaped}"`;
}

export interface AutostartEntryOptions {
  /** What to launch: the AppImage file or the installed executable. */
  execPath: string;
  /** Extra arguments in front of `--hidden` (none for a packaged app). */
  args?: string[];
}

/** The `Exec=` value: the app, then `--hidden`. */
export function autostartExec(options: AutostartEntryOptions): string {
  return [options.execPath, ...(options.args ?? []), HIDDEN_FLAG].map(quoteExecArg).join(' ');
}

/** `~/.config/autostart/agentdeck.desktop` — starts the app at login, window hidden. */
export function autostartEntry(options: AutostartEntryOptions): string {
  const exec = autostartExec(options);
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=AgentDeck',
    'Comment=Keeps the AgentDeck server running in the background',
    `Exec=${exec}`,
    'Icon=agentdeck',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'NoDisplay=true',
    '',
  ].join('\n');
}

/**
 * The executable an autostart entry (and nothing else) should launch: the
 * AppImage itself — `process.execPath` points into its short-lived mount.
 */
export function autostartTarget(env: NodeJS.ProcessEnv, execPath: string): string {
  return env.APPIMAGE && path.isAbsolute(env.APPIMAGE) ? env.APPIMAGE : execPath;
}

/** Does the desktop (GNOME Tweaks, KDE settings) hold this entry off? `Hidden=true` or `X-GNOME-Autostart-enabled=false`. */
export function isEntryDisabled(text: string): boolean {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[') && line !== '[Desktop Entry]') break; // only the main group counts
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().toLowerCase();
    if (key === 'Hidden' && value === 'true') return true;
    if (key === 'X-GNOME-Autostart-enabled' && value === 'false') return true;
  }
  return false;
}

export class Autostart {
  constructor(
    private readonly fs: FileSystem,
    private readonly file: string,
    private readonly options: () => AutostartEntryOptions,
  ) {}

  /** The entry exists and the desktop has not switched it off. */
  async isEnabled(): Promise<boolean> {
    try {
      return !isEntryDisabled(await this.fs.readFile(this.file));
    } catch {
      return false;
    }
  }

  /** The user's choice in the app: write a fresh, enabled entry (this also undoes a switch-off made in the desktop), or remove it. */
  async set(enabled: boolean): Promise<void> {
    if (!enabled) {
      await this.fs.remove(this.file);
      return;
    }
    await writeFileAtomic(this.fs, this.file, autostartEntry(this.options()), 0o644);
  }

  /**
   * At every start: when the entry exists but points somewhere else (the AppImage moved), fix
   * its `Exec=` line — and nothing else. Whatever the desktop set (Hidden, enabled flag) stays.
   */
  async healExec(): Promise<boolean> {
    let text: string;
    try {
      text = await this.fs.readFile(this.file);
    } catch {
      return false;
    }
    const wanted = `Exec=${autostartExec(this.options())}`;
    const lines = text.split('\n');
    const index = lines.findIndex((line) => line.startsWith('Exec='));
    if (index < 0 || lines[index] === wanted) return false;
    lines[index] = wanted;
    await writeFileAtomic(this.fs, this.file, lines.join('\n'), 0o644);
    return true;
  }
}

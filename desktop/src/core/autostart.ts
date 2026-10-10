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

/** `~/.config/autostart/agentdeck.desktop` — starts the app at login, window hidden. */
export function autostartEntry(options: AutostartEntryOptions): string {
  const exec = [options.execPath, ...(options.args ?? []), HIDDEN_FLAG].map(quoteExecArg).join(' ');
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

export class Autostart {
  constructor(
    private readonly fs: FileSystem,
    private readonly file: string,
    private readonly options: () => AutostartEntryOptions,
  ) {}

  isEnabled(): Promise<boolean> {
    return this.fs.exists(this.file);
  }

  /** Writes (or rewrites, e.g. after the AppImage moved) or removes the entry. */
  async set(enabled: boolean): Promise<void> {
    if (!enabled) {
      await this.fs.remove(this.file);
      return;
    }
    await writeFileAtomic(this.fs, this.file, autostartEntry(this.options()), 0o644);
  }
}

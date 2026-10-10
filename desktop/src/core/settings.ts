import { DEFAULT_DESKTOP_SETTINGS, type DesktopCloseAction, type DesktopSettings } from './contract';
import { readJsonFile, writeFileAtomic, type FileSystem } from './fs';

const CLOSE_ACTIONS: readonly DesktopCloseAction[] = ['ask', 'background', 'stop'];

function isCloseAction(value: unknown): value is DesktopCloseAction {
  return typeof value === 'string' && (CLOSE_ACTIONS as readonly string[]).includes(value);
}

/** The valid fields of an untrusted object (IPC input, settings.json); the rest is dropped. */
export function sanitizeSettingsPatch(raw: unknown): Partial<DesktopSettings> {
  if (!raw || typeof raw !== 'object') return {};
  const input = raw as Record<string, unknown>;
  const patch: Partial<DesktopSettings> = {};
  if (isCloseAction(input.closeAction)) patch.closeAction = input.closeAction;
  if (typeof input.lanAccess === 'boolean') patch.lanAccess = input.lanAccess;
  if (typeof input.launchAtLogin === 'boolean') patch.launchAtLogin = input.launchAtLogin;
  return patch;
}

export function normalizeSettings(raw: unknown): DesktopSettings {
  return { ...DEFAULT_DESKTOP_SETTINGS, ...sanitizeSettingsPatch(raw) };
}

/** `userData/settings.json` — the user's choices, read once and kept in memory. */
export class SettingsStore {
  private current: DesktopSettings = { ...DEFAULT_DESKTOP_SETTINGS };

  constructor(
    private readonly fs: FileSystem,
    private readonly file: string,
  ) {}

  async load(): Promise<DesktopSettings> {
    this.current = normalizeSettings(await readJsonFile(this.fs, this.file));
    return this.get();
  }

  get(): DesktopSettings {
    return { ...this.current };
  }

  async update(patch: Partial<DesktopSettings>): Promise<DesktopSettings> {
    this.current = normalizeSettings({ ...this.current, ...sanitizeSettingsPatch(patch) });
    await writeFileAtomic(this.fs, this.file, `${JSON.stringify(this.current, null, 2)}\n`);
    return this.get();
  }
}

/** Answers the app remembers that are not user-facing settings (`userData/state.json`). */
export interface DesktopState {
  /** The user said "no" to the background-service offer — do not ask again. */
  serviceDeclined: boolean;
  /** Release the user waved off in the update notice. */
  updateIgnored?: string;
}

export function normalizeState(raw: unknown): DesktopState {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    serviceDeclined: input.serviceDeclined === true,
    ...(typeof input.updateIgnored === 'string' && input.updateIgnored ? { updateIgnored: input.updateIgnored } : {}),
  };
}

export class StateStore {
  private current: DesktopState = { serviceDeclined: false };

  constructor(
    private readonly fs: FileSystem,
    private readonly file: string,
  ) {}

  async load(): Promise<DesktopState> {
    this.current = normalizeState(await readJsonFile(this.fs, this.file));
    return this.get();
  }

  get(): DesktopState {
    return { ...this.current };
  }

  async update(patch: Partial<DesktopState>): Promise<DesktopState> {
    this.current = normalizeState({ ...this.current, ...patch });
    await writeFileAtomic(this.fs, this.file, `${JSON.stringify(this.current, null, 2)}\n`);
    return this.get();
  }
}

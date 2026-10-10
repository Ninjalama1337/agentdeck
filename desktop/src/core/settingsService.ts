import type { DesktopSettings } from './contract';
import { sanitizeSettingsPatch } from './settings';

export interface SettingsServiceDeps {
  store: {
    get(): DesktopSettings;
    update(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  };
  autostart: { isEnabled(): Promise<boolean>; set(enabled: boolean): Promise<void> };
  server: {
    /** `--lan` of the installed, app-managed service; null when there is none. */
    serviceLan(): boolean | null;
    /** Rewrites the service / restarts the detached server with the new bind address. */
    applyLanAccess(lan: boolean): Promise<void>;
  };
}

/**
 * The settings as the user sees them. Two values are not stored but looked up,
 * so the UI never disagrees with the machine: "launch at login" is whether the
 * autostart entry exists, "LAN access" is how the installed service is bound.
 */
export class SettingsService {
  constructor(private readonly deps: SettingsServiceDeps) {}

  async get(): Promise<DesktopSettings> {
    const stored = this.deps.store.get();
    return {
      closeAction: stored.closeAction,
      lanAccess: this.deps.server.serviceLan() ?? stored.lanAccess,
      launchAtLogin: await this.deps.autostart.isEnabled(),
    };
  }

  /** Applies a patch (untrusted input is filtered); a side effect that fails leaves the old setting in place. */
  async set(rawPatch: unknown): Promise<DesktopSettings> {
    const patch = sanitizeSettingsPatch(rawPatch);
    const before = await this.get();
    if (patch.launchAtLogin !== undefined && patch.launchAtLogin !== before.launchAtLogin) {
      await this.deps.autostart.set(patch.launchAtLogin);
    }
    if (patch.lanAccess !== undefined && patch.lanAccess !== before.lanAccess) {
      await this.deps.server.applyLanAccess(patch.lanAccess);
    }
    await this.deps.store.update(patch);
    return this.get();
  }
}

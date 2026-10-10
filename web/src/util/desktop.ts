/**
 * The desktop shell (Electron) hands the page `window.agentdeckDesktop`
 * (see DesktopBridge in @agentdeck/shared). Every other client — browser,
 * PWA, APK — has no bridge.
 */
import type { DesktopBridge } from '@agentdeck/shared';

/** The shell's bridge, or null outside the desktop app. */
export function desktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.agentdeckDesktop;
  return bridge && bridge.isDesktop === true ? bridge : null;
}

/** True inside the desktop app's window. */
export function isDesktopApp(): boolean {
  return desktopBridge() !== null;
}

/**
 * Single import point for the shared desktop contract (packages/shared/src/desktop.ts).
 * The file has no imports of its own, so esbuild inlines the few constants and
 * tsc only reads it — no build step of the other workspaces is needed.
 */
export type {
  DesktopBridge,
  DesktopCloseAction,
  DesktopServerMode,
  DesktopServerStatus,
  DesktopServiceAction,
  DesktopSettings,
  ServerCliInfo,
  ServiceCliStatus,
} from '../../../packages/shared/src/desktop';
export {
  DEFAULT_DESKTOP_SETTINGS,
  DESKTOP_SERVICE_UNIT,
  SERVICE_UNIT_MARKER,
} from '../../../packages/shared/src/desktop';

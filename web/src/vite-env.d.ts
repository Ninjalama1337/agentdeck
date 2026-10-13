/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * Compile-time constant injected by vite.config.ts (`define`). Carries the APK
 * version this web build was made for (env VITE_AGENTDECK_APK_VERSION, CI sets
 * it; browser/PWA builds default to '0.0.0-web').
 */
declare const __APK_VERSION__: string;

/**
 * Compile-time constant injected by vite.config.ts (`define`): the GitHub repo
 * (`owner/name`) the APK is downloaded from. Defaults to the upstream repo,
 * overridable via VITE_AGENTDECK_RELEASE_REPO.
 */
declare const __RELEASE_REPO__: string;

/** Capacitor native bridge — only present inside the Android APK shell. */
interface Window {
  Capacitor?: {
    isNativePlatform?: () => boolean;
    /** Native plugins registered in the APK (LocalNotifications, Haptics, …). */
    Plugins?: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>> | undefined>;
  };
  /** Desktop shell bridge (preload script of the Electron app) — absent in browsers, the PWA and the APK. */
  agentdeckDesktop?: import('@agentdeck/shared').DesktopBridge;
}

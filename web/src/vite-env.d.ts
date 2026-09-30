/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * Compile-time constant injected by vite.config.ts (`define`). Carries the APK
 * version this web build was made for (env VITE_AGENTDECK_APK_VERSION, CI sets
 * it; browser/PWA builds default to '0.0.0-web').
 */
declare const __APK_VERSION__: string;

/** Capacitor native bridge — only present inside the Android APK shell. */
interface Window {
  Capacitor?: {
    isNativePlatform?: () => boolean;
    /** Native plugins registered in the APK (LocalNotifications, Haptics, …). */
    Plugins?: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>> | undefined>;
  };
}

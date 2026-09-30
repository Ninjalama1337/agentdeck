/**
 * Runtime platform helpers. `window.Capacitor` only exists inside the native
 * APK shell — the PWA in a normal browser never defines it.
 */

/** True when the UI runs inside the Capacitor/Android WebView. */
export function isNativePlatform(): boolean {
  return typeof window !== 'undefined' && Boolean(window.Capacitor?.isNativePlatform?.());
}

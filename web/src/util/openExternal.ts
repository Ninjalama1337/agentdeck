/**
 * Opens a link outside the app. In the APK the WebView silently drops
 * `target="_blank"` and window.open, so http(s) links go to the system
 * browser (Chrome Custom Tab) through the Capacitor Browser plugin.
 */
import { isNativePlatform } from './platform';

export function isWebUrl(href: string | null | undefined): href is string {
  return typeof href === 'string' && /^https?:\/\//i.test(href);
}

export function openExternal(url: string): void {
  const browser = window.Capacitor?.Plugins?.Browser;
  if (isNativePlatform() && browser?.open) {
    void browser.open({ url }).catch(() => undefined);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** One listener for every `<a target="_blank">` in the app (chat, settings, …). */
export function installExternalLinkHandler(): () => void {
  const onClick = (e: MouseEvent) => {
    if (!isNativePlatform() || e.defaultPrevented) return;
    const a = (e.target as Element | null)?.closest?.('a');
    if (!a || !isWebUrl(a.href) || new URL(a.href).origin === window.location.origin) return;
    e.preventDefault();
    openExternal(a.href);
  };
  document.addEventListener('click', onClick);
  return () => document.removeEventListener('click', onClick);
}

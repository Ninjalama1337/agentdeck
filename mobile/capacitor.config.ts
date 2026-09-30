import type { CapacitorConfig } from '@capacitor/cli';

/**
 * AgentDeck — Capacitor 7 configuration (Android wrapper for web/dist).
 *
 * WHY `cleartext: true`?
 * ----------------------
 * AgentDeck is designed for the local network: the backend serves plain
 * `http://<lan-ip>:8787` without TLS. Android blocks cleartext (non-HTTPS)
 * traffic by default since API 28, so the flag below explicitly allows the
 * app to talk to your LAN server. `allowMixedContent` is required as well
 * because the WebView origin is `https://localhost` (androidScheme) and the
 * API calls go out over plain http — the WebView would otherwise block them
 * as mixed content.
 *
 * HOW TO DISABLE FOR WAN/TLS:
 * ---------------------------
 * If you expose AgentDeck through a TLS reverse proxy (see docs/SECURITY.md,
 * Caddy example) and always reach it via https, remove BOTH `cleartext`
 * and the whole `android.allowMixedContent` block:
 *
 *   server: { androidScheme: 'https' }
 *
 * The server address is configured inside the app (settings), so switching
 * from `http://192.168.x.x:8787` to `https://agentdeck.example.com` needs no
 * rebuild.
 */
const config: CapacitorConfig = {
  appId: 'com.ninjalama.agentdeck',
  appName: 'AgentDeck',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;

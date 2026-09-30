import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// Resolve the shared workspace package from its TypeScript sources so the web
// app builds (and typechecks) even before `packages/shared` has been compiled.
const sharedSource = new URL('../packages/shared/src/index.ts', import.meta.url).pathname;

// Version baked into this web build for the APK self-update banner. APK builds
// set VITE_AGENTDECK_APK_VERSION (the CI workflow does); browser/PWA builds
// default to '0.0.0-web', which always compares older than a real APK version.
const apkVersion = process.env.VITE_AGENTDECK_APK_VERSION ?? '0.0.0-web';

export default defineConfig({
  define: {
    __APK_VERSION__: JSON.stringify(apkVersion),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'injectManifest',
      // Custom service worker source (Workbox injectManifest mode).
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        injectionPoint: 'self.__WB_MANIFEST',
      },
      includeAssets: ['icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'share/index.html'],
      // The manifest is shipped as a static file: public/manifest.webmanifest
      // (it carries the Android share_target, linked from index.html).
      manifest: false,
    }),
  ],
  resolve: {
    alias: {
      '@agentdeck/shared': sharedSource,
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:8787', ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});

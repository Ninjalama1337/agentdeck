/// <reference lib="webworker" />
/// <reference types="vite/client" />

/**
 * AgentDeck service worker (Workbox injectManifest mode).
 *
 * - Precaches the app shell and serves SPA navigations from it.
 * - Intercepts the Android share_target POST to /share, stashes the shared
 *   image into the Cache API and redirects into the app (?shared=1), where
 *   App.tsx picks it up and queues it for the chat composer.
 */
import { createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

interface WbManifestEntry {
  url: string;
  revision: string | null;
}

declare global {
  interface Window {
    __WB_MANIFEST: WbManifestEntry[];
  }
}

const swSelf = self as unknown as ServiceWorkerGlobalScope;

// Workbox replaces this literal with the build manifest.
const manifest = self.__WB_MANIFEST as unknown as Parameters<typeof precacheAndRoute>[0];
precacheAndRoute(manifest);

registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/api\//, /^\/socket\.io\//, /^\/share$/],
  }),
);

async function downscaleImage(file: Blob): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const max = 2048;
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  } catch {
    return file;
  }
}

swSelf.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === '/share') {
    event.respondWith(
      (async () => {
        try {
          const form = await event.request.formData();
          const file = form.get('file');
          if (file instanceof File) {
            const blob = await downscaleImage(file);
            const cache = await caches.open('agentdeck-share');
            await cache.put(
              '/__shared__',
              new Response(blob, { headers: { 'content-type': blob.type || 'application/octet-stream' } }),
            );
          }
        } catch {
          // Best effort — still redirect into the app.
        }
        return Response.redirect(new URL('/?shared=1', event.request.url).toString(), 303);
      })(),
    );
  }
});

swSelf.addEventListener('install', () => {
  void swSelf.skipWaiting();
});

swSelf.addEventListener('activate', () => {
  void swSelf.clients.claim();
});

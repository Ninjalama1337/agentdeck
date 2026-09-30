import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './design/global.css';

// PWA registration (no-op in dev). Dynamic import keeps the app resilient if
// the virtual module is unavailable for any reason.
void import('virtual:pwa-register')
  .then((m) => m.registerSW({ immediate: true }))
  .catch(() => {
    /* service worker unavailable — app still works online */
  });

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('missing #root element');
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

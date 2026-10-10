function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Page the window shows while the server is starting or unreachable. It keeps
 * asking `/api/health` and moves on to the app as soon as something answers —
 * no help from the main process needed (no preload, no IPC).
 */
export function statusPageHtml(options: { origin: string; title: string; detail?: string }): string {
  const target = `${options.origin}/`;
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>AgentDeck</title>
<style>
  html, body { height: 100%; margin: 0; background: #0b0e14; color: #e6e8ee; font: 15px system-ui, sans-serif; }
  main { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; padding: 0 24px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0; }
  p { margin: 0; color: #9aa3b5; max-width: 38em; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #5b8cff; animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }
</style>
</head>
<body>
<main>
  <div class="dot"></div>
  <h1>${escapeHtml(options.title)}</h1>
  ${options.detail ? `<p>${escapeHtml(options.detail)}</p>` : ''}
</main>
<script>
  const target = ${JSON.stringify(target).replace(/</g, '\\u003c')};
  async function tick() {
    try {
      await fetch(target + 'api/health', { mode: 'no-cors', cache: 'no-store' });
      location.replace(target);
    } catch {
      setTimeout(tick, 1500);
    }
  }
  setTimeout(tick, 600);
</script>
</body>
</html>
`;
}

export function statusPageUrl(options: { origin: string; title: string; detail?: string }): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(statusPageHtml(options))}`;
}

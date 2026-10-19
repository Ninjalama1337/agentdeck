/**
 * Renders a ```mermaid fence as a diagram. Mermaid is a ~1 MB library, so it is
 * imported only when a diagram first appears in the chat — the initial bundle
 * stays small. A chart that does not parse (or is still streaming) falls back to
 * the plain code block instead of an error.
 */
import { memo, useEffect, useState } from 'react';
import { Spinner } from './Spinner';

let initialized = false;
let seq = 0;
/** Renders run one after another; Mermaid uses a temporary node per render id. */
let queue: Promise<unknown> = Promise.resolve();

/** A fresh render id per call: a streaming chart must not reuse a render's DOM id. */
export function nextMermaidId(): string {
  return `ad-mermaid-${++seq}`;
}

async function renderNow(chart: string): Promise<string> {
  const mermaid = (await import('mermaid')).default;
  if (!initialized) {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      // Client-supplied diagrams from agent output: sanitize what Mermaid emits.
      securityLevel: 'strict',
      fontFamily: 'inherit',
    });
    initialized = true;
  }
  const { svg } = await mermaid.render(nextMermaidId(), chart);
  return svg;
}

function renderChart(chart: string, stale: () => boolean): Promise<string> {
  const run = () => {
    // A newer chart superseded this one while it waited in the queue.
    if (stale()) return Promise.reject(new Error('stale mermaid render'));
    return renderNow(chart);
  };
  const result = queue.then(run, run);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export const MermaidDiagram = memo(function MermaidDiagram({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg(undefined);
    setFailed(false);
    renderChart(chart, () => cancelled).then(
      (out) => {
        if (!cancelled) setSvg(out);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [chart]);

  // Unparseable or not finished streaming: show the source as a normal code block.
  if (failed) {
    return (
      <pre>
        <code className="language-mermaid">{chart}</code>
      </pre>
    );
  }

  if (!svg) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-line bg-white/[0.03] px-3 py-2 text-[11.5px] text-dim">
        <Spinner size={12} /> Rendering diagram…
      </div>
    );
  }

  return (
    <div
      className="md-mermaid"
      role="img"
      aria-label="Diagram"
      // Mermaid's own SVG, sanitized by securityLevel 'strict'.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
});

/**
 * Renders a ```mermaid fence as a diagram. Mermaid is a ~1 MB library, so it is
 * imported only when a diagram first appears in the chat — the initial bundle
 * stays small. A chart that does not parse (or is still streaming) falls back to
 * the plain code block instead of an error.
 */
import { memo, useEffect, useRef, useState } from 'react';
import { Spinner } from './Spinner';

let initialized = false;
let seq = 0;

async function renderChart(id: string, chart: string): Promise<string> {
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
  const { svg } = await mermaid.render(id, chart);
  return svg;
}

export const MermaidDiagram = memo(function MermaidDiagram({ chart }: { chart: string }) {
  const [svg, setSvg] = useState<string>();
  const [failed, setFailed] = useState(false);
  const idRef = useRef(`ad-mermaid-${++seq}`);

  useEffect(() => {
    let cancelled = false;
    setSvg(undefined);
    setFailed(false);
    renderChart(idRef.current, chart).then(
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

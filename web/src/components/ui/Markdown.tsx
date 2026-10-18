import { isValidElement, memo, useRef, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { Check, Copy } from 'lucide-react';
import { MermaidDiagram } from './Mermaid';

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement | null>(null);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const text = ref.current?.innerText ?? '';
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="group relative">
      <pre ref={ref}>{children}</pre>
      <button type="button" className="code-copy" aria-label="Copy code" onClick={() => void copy()}>
        {copied ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
      </button>
    </div>
  );
}

/** The source of a ```mermaid fence, when `pre` wraps such a code block. */
export function mermaidSource(children: ReactNode): string | undefined {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (!isValidElement(child)) continue;
    const props = child.props as { className?: string; children?: ReactNode };
    if (typeof props.className === 'string' && props.className.includes('language-mermaid')) {
      const inner = props.children;
      const text = Array.isArray(inner) ? inner.join('') : inner;
      if (typeof text === 'string') return text;
    }
  }
  return undefined;
}

const components: Components = {
  pre: ({ children }) => {
    const chart = mermaidSource(children);
    if (chart !== undefined) return <MermaidDiagram chart={chart} />;
    return <CodeBlock>{children}</CodeBlock>;
  },
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  img: ({ src, alt }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} loading="lazy" />
  ),
};

const remarkPlugins = [remarkGfm];

/** Memoized: parsing is the expensive part of a chat render, and a finished message never changes. */
export const MarkdownView = memo(function MarkdownView({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </Markdown>
    </div>
  );
});

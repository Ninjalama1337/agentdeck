import { useEffect, useRef } from 'react';
import { Search, X } from 'lucide-react';
import type { ChatMessage } from '@agentdeck/shared';

/** Case-insensitive match over a message's text, thinking and tool summaries. */
export function messageMatches(msg: ChatMessage, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [msg.text, msg.thinking ?? '', ...(msg.tools ?? []).map((t) => `${t.tool} ${t.summary ?? ''}`)];
  return hay.some((h) => h.toLowerCase().includes(q));
}

export function ChatSearch({
  query,
  onChange,
  onClose,
  count,
}: {
  query: string;
  onChange: (q: string) => void;
  onClose: () => void;
  count: number;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="flex items-center gap-2 border-b border-line px-3 py-2">
      <Search size={15} className="shrink-0 text-dim" aria-hidden />
      <input
        ref={ref}
        value={query}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search this chat"
        aria-label="Search this chat"
        className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-dim"
      />
      {query.trim() && (
        <span className="shrink-0 text-[11.5px] text-dim">
          {count} match{count === 1 ? '' : 'es'}
        </span>
      )}
      <button type="button" onClick={onClose} aria-label="Close search" className="press tap shrink-0 text-dim">
        <X size={16} />
      </button>
    </div>
  );
}

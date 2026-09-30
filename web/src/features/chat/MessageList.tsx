import { useState } from 'react';
import { AlertTriangle, Brain, ChevronDown, ChevronRight, Download, FileText, Wrench } from 'lucide-react';
import { clsx } from 'clsx';
import type { AgentInfo, Attachment, ChatMessage } from '@agentdeck/shared';
import { useAppStore } from '../../store/appStore';
import type { StreamDraft, ToolCard } from '../../store/appStore';
import { useStickyScroll } from '../../hooks/useStickyScroll';
import { MarkdownView } from '../../components/ui/Markdown';
import { AgentAvatar } from '../../components/ui/Avatar';
import { Spinner } from '../../components/ui/Spinner';
import { clock, cost, tokens } from '../../util/format';

export function MessageList({
  messages,
  draft,
  agent,
  loading,
}: {
  messages: ChatMessage[] | undefined;
  draft: StreamDraft | undefined;
  agent: AgentInfo | undefined;
  loading: boolean;
}) {
  const scrollRef = useStickyScroll<HTMLDivElement>();
  const accent = agent?.accentColor ?? '#7C5CFF';

  const hasDraft = draft !== undefined && (draft.text.length > 0 || draft.tools.length > 0);

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 pb-4 pt-2">
      {loading && (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      )}

      {!loading && (!messages || messages.length === 0) && !hasDraft && (
        <div className="flex flex-col items-center justify-center px-8 py-16 text-center">
          <AgentAvatar agent={agent} agentId={agent?.id ?? 'claude'} size="lg" glow={false} />
          <p className="mt-4 text-[15px] font-semibold">Ready when you are</p>
          <p className="mt-1.5 max-w-[30ch] text-[13px] leading-relaxed text-dim">
            Send a message, attach a screenshot, or start a team run from the header.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {(messages ?? []).map((msg) => (
          <MessageBubble key={msg.id} msg={msg} agent={agent} accent={accent} />
        ))}

        {hasDraft && draft && (
          <StreamingBubble draft={draft} agent={agent} accent={accent} />
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- bubbles */

function MessageBubble({ msg, agent, accent }: { msg: ChatMessage; agent?: AgentInfo; accent: string }) {
  const setLightbox = useAppStore((s) => s.setLightbox);

  if (msg.role === 'system') {
    return (
      <div className="msg-in mx-auto max-w-[85%] rounded-2xl border border-line bg-white/[0.04] px-4 py-2.5 text-center text-[12.5px] leading-relaxed text-dim">
        {msg.text}
      </div>
    );
  }

  if (msg.role === 'error') {
    return (
      <div
        className="msg-in flex items-start gap-2 rounded-2xl border border-danger/35 bg-danger/10 px-3.5 py-3 text-[13.5px] leading-relaxed text-danger"
        role="alert"
      >
        <AlertTriangle size={15} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">{msg.text}</div>
      </div>
    );
  }

  if (msg.role === 'user') {
    return (
      <div className="msg-in flex flex-col items-end">
        {msg.attachments.length > 0 && (
          <div className="mb-1.5 flex max-w-[85%] flex-wrap justify-end gap-1.5">
            {msg.attachments.map((att) => (
              <AttachmentThumb key={att.id} att={att} onOpen={() => setLightbox({ url: att.url, name: att.name })} />
            ))}
          </div>
        )}
        {msg.text && (
          <div
            className="max-w-[85%] whitespace-pre-wrap break-words rounded-3xl rounded-br-lg border px-4 py-2.5 text-[15px] leading-relaxed"
            style={{ background: `${accent}1c`, borderColor: `${accent}38`, color: '#E7ECF5' }}
          >
            {msg.text}
          </div>
        )}
        <p className="mt-1 px-1 text-[10.5px] text-dim/70">
          {clock(msg.ts)}
          {msg.source && msg.source !== 'app' ? ` · via ${msg.source}` : ''}
        </p>
      </div>
    );
  }

  // assistant
  return (
    <div className="msg-in flex flex-col items-start">
      {msg.attachments.length > 0 && (
        <div className="mb-1.5 flex max-w-[85%] flex-wrap gap-1.5">
          {msg.attachments.map((att) => (
            <AttachmentThumb key={att.id} att={att} onOpen={() => setLightbox({ url: att.url, name: att.name })} />
          ))}
        </div>
      )}
      <div
        className="glass max-w-[92%] overflow-hidden py-2.5 pl-3.5 pr-3"
        style={{ borderLeft: `3px solid ${accent}` }}
      >
        <div className="mb-1 flex items-center gap-2 text-[11px] text-dim">
          <span className="font-medium" style={{ color: accent }}>
            {agent?.label ?? msg.agentId ?? 'agent'}
          </span>
          {msg.model && <span className="font-mono text-[10.5px] text-dim/75">{msg.model}</span>}
          <span className="ml-auto">{clock(msg.ts)}</span>
        </div>
        {msg.thinking && msg.thinking.trim() && (
          <ThinkingBlock thinking={msg.thinking} accent={accent} />
        )}
        <MarkdownView text={msg.text} />
        {msg.usage && <UsageLine usage={msg.usage} />}
      </div>
    </div>
  );
}

function StreamingBubble({ draft, agent, accent }: { draft: StreamDraft; agent?: AgentInfo; accent: string }) {
  return (
    <div className="msg-in flex flex-col items-start">
      <div
        className="glass max-w-[92%] overflow-hidden py-2.5 pl-3.5 pr-3"
        style={{ borderLeft: `3px solid ${accent}` }}
      >
        <div className="mb-1 flex items-center gap-2 text-[11px] text-dim">
          <span className="font-medium" style={{ color: accent }}>
            {agent?.label ?? 'agent'}
          </span>
          <span className="inline-flex items-center gap-1 text-[10.5px]" style={{ color: accent }}>
            <span className="h-1.5 w-1.5 rounded-full pulse-dot" style={{ background: accent }} />
            working…
          </span>
        </div>

        {draft.tools.length > 0 && (
          <div className="mb-2 flex flex-col gap-1">
            {draft.tools.map((tool) => (
              <ToolRow key={tool.id} card={tool} />
            ))}
          </div>
        )}

        {(draft.thinking ?? '').trim() !== '' && (
          <ThinkingBlock thinking={draft.thinking ?? ''} accent={accent} streaming />
        )}

        {draft.text ? (
          <div className="min-w-0">
            <MarkdownView text={draft.text} />
            <span className="caret" aria-hidden />
          </div>
        ) : (
          <span className="caret" aria-hidden />
        )}

        {draft.usage && <UsageLine usage={draft.usage} />}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- fragments */

/** Collapsible reasoning ("thinking") — kept strictly separate from the answer. */
function ThinkingBlock({ thinking, accent, streaming }: { thinking: string; accent: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  const words = thinking.trim().split(/\s+/).length;
  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-line bg-black/25">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="press tap flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Brain size={13} style={{ color: accent }} aria-hidden />
        <span className="text-[11.5px] font-medium text-dim">
          {streaming ? 'Thinking…' : 'Thinking'}
          <span className="ml-1.5 font-normal text-dim/70">· {words} words</span>
        </span>
        {streaming && <span className="h-1.5 w-1.5 rounded-full pulse-dot" style={{ background: accent }} aria-hidden />}
        <span className="ml-auto text-dim/70">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
      </button>
      {open && (
        <div className="max-h-64 overflow-y-auto border-t border-line px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-dim/90">
          {thinking.trim()}
        </div>
      )}
    </div>
  );
}

function ToolRow({ card }: { card: ToolCard }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-line bg-white/[0.04]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="tap flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {card.state === 'running' ? (
          <Spinner size={13} className="shrink-0 text-accent" />
        ) : (
          <span
            className={clsx(
              'flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
              card.state === 'done' ? 'bg-ok/15 text-ok' : 'bg-danger/15 text-danger',
            )}
          >
            <Wrench size={10} />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink/90">{card.tool}</span>
        {card.summary && <span className="hidden min-w-0 flex-1 truncate text-[11.5px] text-dim min-[380px]:block">{card.summary}</span>}
        <ChevronDown size={13} className={clsx('shrink-0 text-dim transition-transform', open && 'rotate-180')} />
      </button>
      {open && card.summary && (
        <p className="whitespace-pre-wrap break-words border-t border-line px-3 py-2 text-[12px] leading-relaxed text-dim">
          {card.summary}
        </p>
      )}
    </div>
  );
}

function AttachmentThumb({ att, onOpen }: { att: Attachment; onOpen: () => void }) {
  if (att.kind === 'image') {
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={`View ${att.name}`}
        className="relative h-14 w-14 overflow-hidden rounded-xl border border-line active:opacity-80"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={att.url} alt={att.name} className="h-full w-full object-cover" loading="lazy" />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className="tap flex max-w-[220px] items-center gap-2 rounded-xl border border-line bg-white/[0.05] px-3 py-2 text-left"
    >
      <FileText size={15} className="shrink-0 text-accent-blue" />
      <span className="min-w-0 flex-1 truncate text-[12px]">{att.name}</span>
      <Download size={13} className="shrink-0 text-dim" />
    </button>
  );
}

export function UsageLine({ usage }: { usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } }) {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`${tokens(usage.inputTokens)} in`);
  if (usage.outputTokens !== undefined) parts.push(`${tokens(usage.outputTokens)} out`);
  const c = cost(usage.costUsd);
  if (c) parts.push(c);
  if (!parts.length) return null;
  return (
    <p className="mt-2 border-t border-line pt-1.5 font-mono text-[10.5px] text-dim/75">↳ {parts.join(' · ')}</p>
  );
}

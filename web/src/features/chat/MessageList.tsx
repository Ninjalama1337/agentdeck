import { memo, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, Brain, Check, ChevronDown, ChevronRight, Copy, Download, FileText, ImageOff, Pencil, RotateCcw, Wrench } from 'lucide-react';
import { clsx } from 'clsx';
import { splitThinkTags } from '@agentdeck/shared';
import type { AgentInfo, Attachment, ChatMessage, ToolRecord } from '@agentdeck/shared';
import { errorMessage, useAppStore } from '../../store/appStore';
import type { StreamDraft, ToolCard } from '../../store/appStore';
import { useStickyScroll } from '../../hooks/useStickyScroll';
import { useAttachmentUrl } from '../../hooks/useAttachmentUrl';
import { MarkdownView } from '../../components/ui/Markdown';
import { AgentAvatar } from '../../components/ui/Avatar';
import { useChatActions } from '../../store/chatActions';
import { Spinner } from '../../components/ui/Spinner';
import { clock, cost, tokens } from '../../util/format';
import { parseAttachmentUrl } from '../../util/attachments';
import { downloadFile, isShareCancel } from '../../util/download';

const EMPTY_DRAFT: StreamDraft = { text: '', tools: [] };

function draftHasContent(draft: StreamDraft | undefined): boolean {
  return draft !== undefined && (draft.text.length > 0 || draft.tools.length > 0 || (draft.thinking ?? '').trim() !== '');
}

export function MessageList({
  sessionId,
  messages,
  agent,
  loading,
  running,
}: {
  sessionId: string;
  messages: ChatMessage[] | undefined;
  agent: AgentInfo | undefined;
  loading: boolean;
  running: boolean;
}) {
  const { ref: scrollRef, contentRef, atBottom, unseen, scrollToBottom } = useStickyScroll<HTMLDivElement>();
  const accent = agent?.accentColor ?? '#7C5CFF';
  // Only whether there is a live answer — its text is read by LiveAnswer, so
  // the history does not re-render with every streamed word.
  const hasDraft = useAppStore((s) => draftHasContent(s.drafts[sessionId]));
  // While a run is active the bubble is always there — even before the first token arrives.
  const showBubble = hasDraft || running;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} data-chat-scroll className="flex-1 overflow-y-auto px-3 pb-4 pt-2">
        <div ref={contentRef}>
          {loading && (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          )}

          {!loading && (!messages || messages.length === 0) && !showBubble && (
            <div className="flex flex-col items-center justify-center px-8 py-16 text-center">
              <AgentAvatar agent={agent} agentId={agent?.id ?? 'claude'} size="lg" glow={false} />
              <p className="mt-4 text-[15px] font-semibold">Ready when you are</p>
              <p className="mt-1.5 max-w-[30ch] text-[13px] leading-relaxed text-dim">
                Send a message, attach a screenshot, or start a team run from the header.
              </p>
            </div>
          )}

          <div className="flex flex-col gap-3">
            {(messages ?? []).map((msg, i, all) => {
              // Regenerate = resend the prompt of the final exchange; only offered on the last answer.
              const lastUser = i === all.length - 1 && msg.role === 'assistant' && !running
                ? [...all].reverse().find((m) => m.role === 'user')
                : undefined;
              return <MessageBubble key={msg.id} msg={msg} agent={agent} accent={accent} regenerateFrom={lastUser} />;
            })}

            {showBubble && <LiveAnswer sessionId={sessionId} agent={agent} accent={accent} />}
          </div>
        </div>
      </div>

      {!atBottom && (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label={unseen ? 'New messages — jump to latest' : 'Jump to latest'}
          className="press absolute bottom-3 right-3 z-10 flex h-10 w-10 items-center justify-center rounded-full border border-line bg-[#1a1f2c] text-ink shadow-lg"
        >
          <ArrowDown size={18} />
          {unseen && (
            <span
              aria-hidden
              className="pulse-dot absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full"
              style={{ background: accent }}
            />
          )}
        </button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- bubbles */

/** The answer being written — subscribes to its own draft. */
function LiveAnswer({ sessionId, agent, accent }: { sessionId: string; agent?: AgentInfo; accent: string }) {
  const draft = useAppStore((s) => s.drafts[sessionId]);
  return <StreamingBubble draft={draft ?? EMPTY_DRAFT} agent={agent} accent={accent} />;
}

/** Memoized: a finished message only re-renders when the message itself changes. */
const MessageBubble = memo(function MessageBubble({
  msg,
  agent,
  accent,
  regenerateFrom,
}: {
  msg: ChatMessage;
  agent?: AgentInfo;
  accent: string;
  regenerateFrom?: ChatMessage;
}) {
  const sendTurn = useAppStore((s) => s.sendTurn);

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
              <AttachmentThumb key={att.id} att={att} />
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
        <p className="mt-1 flex items-center gap-2 px-1 text-[10.5px] text-dim/70">
          <span>
            {clock(msg.ts)}
            {msg.source && msg.source !== 'app' ? ` · via ${msg.source}` : ''}
          </span>
          {msg.text && (
            <button
              type="button"
              onClick={() => useChatActions.getState().setPrefill(msg.sessionId, msg.text)}
              aria-label="Edit and resend"
              className="press inline-flex items-center gap-1 text-dim/70"
            >
              <Pencil size={11} /> Edit
            </button>
          )}
        </p>
      </div>
    );
  }

  // assistant — older messages may still carry inline <think> tags in the text
  const split = splitThinkTags(msg.text);
  const answer = split.text.trim();
  const thinking = [msg.thinking?.trim(), split.thinking.trim()].filter(Boolean).join('\n\n');
  return (
    <div className="msg-in flex flex-col items-start">
      {msg.attachments.length > 0 && (
        <div className="mb-1.5 flex max-w-[85%] flex-wrap gap-1.5">
          {msg.attachments.map((att) => (
            <AttachmentThumb key={att.id} att={att} />
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
          {answer && <CopyButton text={answer} />}
        </div>
        {msg.tools && msg.tools.length > 0 && <ToolGroup tools={msg.tools} />}
        {thinking && <ThinkingBlock thinking={thinking} accent={accent} />}
        {answer && <MarkdownView text={answer} />}
        {msg.usage && <UsageLine usage={msg.usage} />}
        {regenerateFrom && regenerateFrom.text && (
          <button
            type="button"
            onClick={() => void sendTurn(msg.sessionId, regenerateFrom.text, regenerateFrom.attachments).catch(() => undefined)}
            className="press tap mt-2 inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[11.5px] text-dim"
          >
            <RotateCcw size={12} /> Regenerate
          </button>
        )}
      </div>
    </div>
  );
});

/**
 * Text as it should be rendered right now. Parsing Markdown costs more the
 * longer the answer gets, so a long one is re-rendered at a slower beat
 * instead of with every bundle of tokens.
 */
function usePacedText(text: string): string {
  const interval = text.length < 4_000 ? 0 : text.length < 20_000 ? 120 : 300;
  const [shown, setShown] = useState(text);
  const shownAt = useRef(0);
  // Short answers follow directly; `shown` tags along so the switch to the slower beat starts from the current text.
  if (interval === 0 && shown !== text) setShown(text);
  useEffect(() => {
    if (interval === 0) return;
    const timer = window.setTimeout(
      () => {
        shownAt.current = performance.now();
        setShown(text);
      },
      Math.max(0, shownAt.current + interval - performance.now()),
    );
    return () => window.clearTimeout(timer);
  }, [text, interval]);
  return interval === 0 ? text : shown;
}

function StreamingBubble({ draft, agent, accent }: { draft: StreamDraft; agent?: AgentInfo; accent: string }) {
  const text = usePacedText(draft.text);
  const phase = draft.text
    ? 'writing…'
    : draft.tools.some((t) => t.state === 'running')
      ? 'working…'
      : (draft.thinking ?? '').trim() !== ''
        ? 'thinking…'
        : 'waiting for response…';
  return (
    <div className="msg-in flex flex-col items-start">
      <div
        className="glass max-w-[92%] overflow-hidden py-2.5 pl-3.5 pr-3"
        style={{ borderLeft: `3px solid ${accent}`, '--ad-agent': accent } as React.CSSProperties}
      >
        <div className="mb-1 flex items-center gap-2 text-[11px] text-dim">
          <span className="font-medium" style={{ color: accent }}>
            {agent?.label ?? 'agent'}
          </span>
          <span className="inline-flex items-center gap-1 text-[10.5px]" style={{ color: accent }}>
            <span className="h-1.5 w-1.5 rounded-full pulse-dot" style={{ background: accent }} />
            {phase}
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

        {text ? (
          <div className="md-live min-w-0">
            <MarkdownView text={text} />
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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label="Copy answer"
      className="press -my-1 -mr-1 flex h-6 w-6 items-center justify-center rounded-md text-dim/70"
    >
      {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
    </button>
  );
}

/** Tool calls of a finished turn — one collapsed line, expandable to the individual calls. */
function ToolGroup({ tools }: { tools: ToolRecord[] }) {
  const [open, setOpen] = useState(false);
  const failed = tools.filter((t) => !t.ok).length;
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="press tap flex items-center gap-1.5 rounded-lg px-1 py-1 text-[11.5px] text-dim"
      >
        <Wrench size={12} aria-hidden />
        {tools.length} tool call{tools.length === 1 ? '' : 's'}
        {failed > 0 && <span className="text-danger">· {failed} failed</span>}
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-1">
          {tools.map((t, i) => (
            <ToolRow key={i} card={{ id: i, tool: t.tool, state: t.ok ? 'done' : 'error', summary: t.summary }} />
          ))}
        </div>
      )}
    </div>
  );
}

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

function AttachmentThumb({ att }: { att: Attachment }) {
  return att.kind === 'image' ? <ImageThumb att={att} /> : <FileChip att={att} />;
}

/** Image attachment: loaded with the device login once it scrolls near the screen. */
function ImageThumb({ att }: { att: Attachment }) {
  const setLightbox = useAppStore((s) => s.setLightbox);
  const box = useRef<HTMLButtonElement | null>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = box.current;
    if (near || !el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      // Measured against the chat list, so the margin reaches into what is scrolled out of view.
      { root: el.closest('[data-chat-scroll]'), rootMargin: '400px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near]);
  const { url, failed } = useAttachmentUrl(near ? att : undefined);

  return (
    <button
      ref={box}
      type="button"
      disabled={!url}
      onClick={() => url && setLightbox({ url, name: att.name })}
      aria-label={`View ${att.name}`}
      className="relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-xl border border-line bg-white/[0.05] active:opacity-80"
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={att.name} className="h-full w-full object-cover" />
      ) : failed ? (
        <ImageOff size={16} className="text-dim" aria-label="Image unavailable" />
      ) : (
        <Spinner size={14} className="text-dim" />
      )}
    </button>
  );
}

/** Any other attachment: a tap saves it to the device. */
function FileChip({ att }: { att: Attachment }) {
  const toast = useAppStore((s) => s.toast);
  const save = async () => {
    const target = parseAttachmentUrl(att.url);
    if (!target) return;
    try {
      const via = await downloadFile(target.projectId, target.path, att.name, () => toast('info', `Downloading ${att.name}…`));
      if (via === 'saved') toast('info', `Saved ${att.name} to Downloads`);
    } catch (err) {
      if (!isShareCancel(err)) toast('error', errorMessage(err));
    }
  };
  return (
    <button
      type="button"
      onClick={() => void save()}
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

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Camera, FileText, Image as ImageIcon, Paperclip, Square, Wand2, X } from 'lucide-react';
import { clsx } from 'clsx';
import type { AgentInfo, Attachment, Session } from '@agentdeck/shared';
import { api, uploadFile } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';
import { Sheet } from '../../components/ui/Sheet';
import { Spinner } from '../../components/ui/Spinner';
import { DictationHint, MicButton } from '../../components/MicButton';
import { useDictation } from '../../hooks/useDictation';
import { usePrefs } from '../../store/prefs';
import { useChatActions } from '../../store/chatActions';
import { haptic } from '../../util/haptics';

interface PendingAttachment {
  localId: string;
  name: string;
  size: number;
  progress: number;
  att?: Attachment;
  error?: string;
}

let localSeq = 0;

export function Composer({ session, agent }: { session: Session; agent: AgentInfo | undefined }) {
  const sendTurn = useAppStore((s) => s.sendTurn);
  const interrupt = useAppStore((s) => s.interrupt);
  const toast = useAppStore((s) => s.toast);
  const takePendingFiles = useAppStore((s) => s.takePendingFiles);
  const projects = useAppStore((s) => s.projects);

  const [text, setText] = useState('');
  const [atts, setAtts] = useState<PendingAttachment[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const enterToSend = usePrefs((st) => st.enterToSend);
  const dictation = useDictation(
    (spoken) => setText((t) => (t && !/\s$/.test(t) ? `${t} ${spoken}` : `${t}${spoken}`)),
    (msg) => toast('error', msg),
  );
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const photoInput = useRef<HTMLInputElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const anyInput = useRef<HTMLInputElement | null>(null);

  const projectId = session.projectId;
  const projectName = projects.find((p) => p.id === projectId)?.name ?? projectId;
  const running = session.status === 'running' || session.status === 'queued';
  const canSend = (text.trim().length > 0 || atts.some((a) => a.att)) && !atts.some((a) => !a.att && !a.error);
  const headless = agent?.capabilities.headless === true;

  /* PWA share_target handover → pending files queued by App.tsx */
  useEffect(() => {
    if (!agent?.capabilities.headless) return;
    const files = takePendingFiles();
    if (files.length) void addFiles(files);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, agent?.capabilities.headless]);

  /* "Edit" on a sent message puts its text back into the input */
  const prefill = useChatActions((st) => st.prefill);
  useEffect(() => {
    if (!prefill || prefill.sessionId !== session.id) return;
    setText(prefill.text);
    useChatActions.getState().clearPrefill();
    textarea.current?.focus();
  }, [prefill, session.id]);

  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);

  async function addFiles(files: File[]) {
    for (const file of files) {
      const localId = `att-${Date.now()}-${++localSeq}`;
      setAtts((prev) => [...prev, { localId, name: file.name, size: file.size, progress: 0 }]);
      try {
        const att = await uploadFile(projectId, file, 'uploads', (p) =>
          setAtts((prev) => prev.map((a) => (a.localId === localId ? { ...a, progress: p } : a))),
        );
        setAtts((prev) => prev.map((a) => (a.localId === localId ? { ...a, att, progress: 1 } : a)));
      } catch (err) {
        setAtts((prev) => prev.map((a) => (a.localId === localId ? { ...a, error: errorMessage(err) } : a)));
        toast('error', `Upload failed: ${file.name}`);
      }
    }
  }

  /* BridgeMind "Enhance prompt": transient agent run that rewrites the draft
   * into a crisp instruction — nothing lands in the session history. */
  const enhance = async () => {
    if (!headless || enhancing || !text.trim()) return;
    setEnhancing(true);
    try {
      const res = await api.enhance({
        projectId,
        agentId: session.agentId,
        text: text.trim(),
        ...(session.model !== undefined ? { model: session.model } : {}),
        ...(session.thinkingEffort !== undefined ? { thinkingEffort: session.thinkingEffort } : {}),
        ...(session.accountId !== undefined ? { accountId: session.accountId } : {}),
      });
      if (res.text.trim()) setText(res.text.trim());
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      setEnhancing(false);
      textarea.current?.focus();
    }
  };

  const send = async () => {
    if (!canSend || running) return;
    if (dictation.state !== 'idle') dictation.stop();
    haptic('light');
    const payloadText = text;
    const uploaded = atts.filter((a) => a.att).map((a) => a.att as Attachment);
    setText('');
    setAtts([]);
    try {
      await sendTurn(session.id, payloadText.trim(), uploaded, session.model, session.thinkingEffort);
    } catch {
      // restore so the user can retry
      setText(payloadText);
    }
  };

  /* IDE-mode agents get an explanatory bar instead of a composer. */
  if (agent && !agent.capabilities.headless) {
    return (
      <div className="safe-b px-3 pb-3">
        <div className="glass flex items-center gap-3 rounded-2xl px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-medium">IDE mode</p>
            <p className="truncate text-[12px] text-dim">
              {agent.label} is driven from its editor on the server — history is read-only here.
            </p>
          </div>
          {agent.capabilities.ideLaunch && (
            <button
              type="button"
              onClick={() => void useAppStore.getState().openInIde(session.id)}
              className="press tap shrink-0 rounded-xl bg-accent/20 px-3.5 text-[13px] font-semibold text-accent"
            >
              Open IDE
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="safe-b px-3 pb-3">
      <DictationHint dictation={dictation} />
      {/* attachment strip */}
      {atts.length > 0 && (
        <div className="no-scrollbar mb-2 flex gap-2 overflow-x-auto px-0.5">
          {atts.map((a) => (
            <div key={a.localId} className="relative shrink-0">
              {a.att && a.att.kind === 'image' ? (
                <div className="h-14 w-14 overflow-hidden rounded-xl border border-line">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={a.att.url} alt={a.att.name} className="h-full w-full object-cover" />
                </div>
              ) : (
                <div className="flex h-14 max-w-[180px] items-center gap-2 rounded-xl border border-line bg-white/[0.05] px-3">
                  <span className="truncate text-[11.5px]">{a.name}</span>
                </div>
              )}
              {!a.att && !a.error && (
                <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/55 text-[11px] font-medium">
                  {Math.round(a.progress * 100)}%
                </div>
              )}
              {a.error && (
                <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/65 px-1 text-center text-[10px] leading-tight text-danger">
                  failed
                </div>
              )}
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                onClick={() => setAtts((prev) => prev.filter((x) => x.localId !== a.localId))}
                className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-line bg-[#1a1f2c] text-dim active:text-ink"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* input row */}
      <div className="composer flex items-end gap-1 rounded-[26px] p-1.5">
        <button
          type="button"
          aria-label="Attach"
          onClick={() => setSheetOpen(true)}
          className="tap flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-dim active:bg-white/10 active:text-ink"
        >
          <Paperclip size={19} />
        </button>
        <textarea
          ref={textarea}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (enterToSend && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          rows={1}
          placeholder={running ? 'Agent is working…' : `Message ${agent?.label ?? 'agent'} in ${projectName}…`}
          aria-label="Message"
          enterKeyHint={enterToSend ? 'send' : 'enter'}
          className="max-h-[132px] min-h-11 flex-1 resize-none bg-transparent px-1 py-2.5 text-[15.5px] leading-snug outline-none placeholder:text-dim/70"
        />
        {headless && text.trim().length > 0 && (
          <button
            type="button"
            aria-label="Enhance prompt with the agent"
            disabled={enhancing}
            onClick={() => void enhance()}
            className={clsx(
              'press flex h-11 w-10 shrink-0 items-center justify-center rounded-full',
              enhancing ? 'text-accent' : 'text-dim active:bg-white/10 active:text-ink',
            )}
          >
            {enhancing ? <Spinner /> : <Wand2 size={17} />}
          </button>
        )}
        <MicButton dictation={dictation} />
        {running ? (
          <button
            type="button"
            aria-label="Stop run"
            onClick={() => {
              haptic('medium');
              void interrupt(session.id);
            }}
            className="press flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-danger/20 text-danger"
          >
            <Square size={16} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Send message"
            disabled={!canSend}
            onClick={() => void send()}
            className={clsx(
              'press btn-primary flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white transition-opacity',
              canSend ? '' : 'opacity-35',
            )}
          >
            <ArrowUp size={20} strokeWidth={2.4} />
          </button>
        )}
      </div>

      {/* attach action sheet */}
      <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Add attachment">
        <div className="flex flex-col gap-1.5">
          <AttachRow
            icon={<Camera size={18} />}
            title="Take photo"
            hint="Capture with the device camera"
            onClick={() => {
              setSheetOpen(false);
              photoInput.current?.click();
            }}
          />
          <AttachRow
            icon={<ImageIcon size={18} />}
            title="Choose image"
            hint="From gallery"
            onClick={() => {
              setSheetOpen(false);
              fileInput.current?.click();
            }}
          />
          <AttachRow
            icon={<FileText size={18} />}
            title="Choose file"
            hint="PDF, text, logs, code"
            onClick={() => {
              setSheetOpen(false);
              anyInput.current?.click();
            }}
          />
          <p className="px-1 pt-1 text-[12px] text-dim">
            Files upload instantly and are attached to your next message. Max 20 MB.
          </p>
        </div>
      </Sheet>

      {/* hidden inputs (kept mounted) */}
      <input
        ref={photoInput}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) void addFiles(files);
        }}
      />
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) void addFiles(files);
        }}
      />
      <input
        ref={anyInput}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) void addFiles(files);
        }}
      />
    </div>
  );
}

function AttachRow({
  icon,
  title,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="press tap flex w-full items-center gap-3 rounded-2xl border border-line bg-white/[0.04] px-4 py-3 text-left active:bg-white/[0.08]"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/15 text-accent">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium">{title}</span>
        <span className="block text-[12px] text-dim">{hint}</span>
      </span>
    </button>
  );
}

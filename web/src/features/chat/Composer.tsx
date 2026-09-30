import { useEffect, useRef, useState } from 'react';
import { Camera, Image as ImageIcon, Mic, MicOff, Paperclip, Send, Square, Wand2, X } from 'lucide-react';
import { clsx } from 'clsx';
import type { AgentInfo, Attachment, Session } from '@agentdeck/shared';
import { api, uploadFile } from '../../api/client';
import { errorMessage, useAppStore } from '../../store/appStore';
import { Sheet } from '../../components/ui/Sheet';
import { Spinner } from '../../components/ui/Spinner';

interface PendingAttachment {
  localId: string;
  name: string;
  size: number;
  progress: number;
  att?: Attachment;
  error?: string;
}

let localSeq = 0;

/* Web Speech API (Chrome PWA); the Capacitor WebView has no recognizer — the
 * mic button simply hides there until a native plugin ships. */
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type SpeechCtor = new () => SpeechRecognitionLike;

function speechCtor(): SpeechCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function Composer({ session, agent }: { session: Session; agent: AgentInfo | undefined }) {
  const sendTurn = useAppStore((s) => s.sendTurn);
  const interrupt = useAppStore((s) => s.interrupt);
  const toast = useAppStore((s) => s.toast);
  const takePendingFiles = useAppStore((s) => s.takePendingFiles);
  const projects = useAppStore((s) => s.projects);
  const activeProjectId = useAppStore((s) => s.activeProjectId);

  const [text, setText] = useState('');
  const [atts, setAtts] = useState<PendingAttachment[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [listening, setListening] = useState(false);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const photoInput = useRef<HTMLInputElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const projectId = session.projectId;
  const projectName = projects.find((p) => p.id === projectId)?.name ?? projectId;
  const running = session.status === 'running' || session.status === 'queued';
  const canSend = (text.trim().length > 0 || atts.some((a) => a.att)) && !atts.some((a) => !a.att && !a.error);
  const headless = agent?.capabilities.headless === true;
  const voiceAvailable = speechCtor() !== null;

  /* PWA share_target handover → pending files queued by App.tsx */
  useEffect(() => {
    if (!agent?.capabilities.headless) return;
    const files = takePendingFiles();
    if (files.length) void addFiles(files);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, agent?.capabilities.headless]);

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

  /* BridgeVoice (lite): hold-free dictation, appends to the draft. */
  const toggleVoice = () => {
    const Ctor = speechCtor();
    if (!Ctor) return;
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const rec = new Ctor();
    recognition.current = rec;
    rec.lang = navigator.language || 'de-DE';
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (event) => {
      const spoken = Array.from({ length: event.results.length }, (_, i) => event.results[i][0]?.transcript ?? '')
        .join(' ')
        .trim();
      if (spoken) setText((t) => (t ? `${t} ${spoken}` : spoken));
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    try {
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  };

  const send = async () => {
    if (!canSend || running) return;
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
      <div className="glass flex items-end gap-1.5 rounded-[26px] p-1.5">
        <button
          type="button"
          aria-label="Attach image"
          onClick={() => setSheetOpen(true)}
          className="tap flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-dim active:bg-white/10 active:text-ink"
        >
          <Paperclip size={19} />
        </button>
        <textarea
          ref={textarea}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={1}
          placeholder={`Message ${projectName}…`}
          aria-label="Message"
          className="max-h-[132px] min-h-11 flex-1 resize-none bg-transparent px-1 py-2.5 text-[15.5px] leading-snug outline-none placeholder:text-dim/70"
        />
        {(headless || voiceAvailable) && text.trim().length > 0 && (
          <div className="flex shrink-0 flex-col items-center justify-center gap-0.5 self-center">
            {headless && (
              <button
                type="button"
                aria-label="Enhance prompt with the agent"
                disabled={enhancing || !text.trim()}
                onClick={() => void enhance()}
                className={clsx(
                  'press flex h-8 w-9 items-center justify-center rounded-lg',
                  enhancing ? 'text-accent' : 'text-dim active:bg-white/10 active:text-ink',
                )}
              >
                {enhancing ? <Spinner /> : <Wand2 size={16} />}
              </button>
            )}
            {voiceAvailable && (
              <button
                type="button"
                aria-label={listening ? 'Stop dictation' : 'Dictate message'}
                onClick={toggleVoice}
                className={clsx(
                  'press flex h-8 w-9 items-center justify-center rounded-lg',
                  listening ? 'text-danger' : 'text-dim active:bg-white/10 active:text-ink',
                )}
              >
                {listening ? <MicOff size={16} /> : <Mic size={16} />}
              </button>
            )}
          </div>
        )}
        {running ? (
          <button
            type="button"
            aria-label="Stop run"
            onClick={() => void interrupt(session.id)}
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
              'press flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white transition-opacity',
              canSend ? '' : 'opacity-35',
            )}
            style={{ background: 'linear-gradient(135deg,#7C5CFF,#4E8CFF)' }}
          >
            <Send size={17} />
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
            hint="From gallery or files"
            onClick={() => {
              setSheetOpen(false);
              fileInput.current?.click();
            }}
          />
          <p className="px-1 pt-1 text-[12px] text-dim">
            Images upload instantly and are attached to your next message. Max 20 MB.
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
        accept="image/*,application/pdf,text/*"
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

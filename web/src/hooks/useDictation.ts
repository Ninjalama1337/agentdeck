/**
 * Voice dictation for the chat composer and the terminal compose bar.
 *
 * Engines:
 *   device — Web Speech API (Chrome/Android PWA): live interim text, no upload
 *   server — MediaRecorder → POST /api/voice/transcribe (Whisper API or a
 *            local whisper.cpp on the server); works inside the APK WebView
 *   auto   — device when available, else server
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { usePrefs } from '../store/prefs';
import { haptic } from '../util/haptics';

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean } & ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechCtor = new () => SpeechRecognitionLike;

export function speechCtor(): SpeechCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function recorderSupported(): boolean {
  return typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;
}

let serverVoice: { checked: boolean; available: boolean } = { checked: false, available: false };

/** Cached GET /api/voice — one probe per app start. */
async function serverVoiceAvailable(): Promise<boolean> {
  if (serverVoice.checked) return serverVoice.available;
  try {
    const st = await api.voiceStatus();
    serverVoice = { checked: true, available: st.available };
  } catch {
    serverVoice = { checked: true, available: false };
  }
  return serverVoice.available;
}

export type DictationState = 'idle' | 'listening' | 'recording' | 'transcribing';

export interface Dictation {
  state: DictationState;
  /** Live (not yet final) words from the device recognizer. */
  interim: string;
  /** Some engine is usable on this device. */
  supported: boolean;
  /** Elapsed recording seconds (server engine). */
  seconds: number;
  toggle(): void;
  stop(): void;
  cancel(): void;
}

/**
 * @param onText receives each finalized chunk of text
 * @param onError user-facing error message
 */
export function useDictation(onText: (text: string) => void, onError?: (msg: string) => void): Dictation {
  const engine = usePrefs((s) => s.dictation);
  const lang = usePrefs((s) => s.dictationLang);
  const [state, setState] = useState<DictationState>('idle');
  const [interim, setInterim] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [serverOk, setServerOk] = useState(serverVoice.available);
  const rec = useRef<SpeechRecognitionLike | null>(null);
  const media = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; cancelled: boolean } | null>(null);
  const tick = useRef<number | null>(null);
  const onTextRef = useRef(onText);
  const onErrorRef = useRef(onError);
  onTextRef.current = onText;
  onErrorRef.current = onError;

  useEffect(() => {
    if (engine === 'device') return;
    let alive = true;
    void serverVoiceAvailable().then((ok) => alive && setServerOk(ok));
    return () => {
      alive = false;
    };
  }, [engine]);

  const device = speechCtor() !== null;
  const server = serverOk && recorderSupported();
  const useDevice = engine === 'device' ? device : engine === 'server' ? false : device;
  const useServer = !useDevice && (engine !== 'device') && server;
  const supported = useDevice || useServer;

  const cleanupMedia = () => {
    if (tick.current) window.clearInterval(tick.current);
    tick.current = null;
    media.current?.stream.getTracks().forEach((t) => t.stop());
    media.current = null;
  };

  useEffect(
    () => () => {
      rec.current?.abort();
      if (media.current) {
        media.current.cancelled = true;
        media.current.recorder.stop();
      }
      cleanupMedia();
    },
    [],
  );

  const startDevice = () => {
    const Ctor = speechCtor();
    if (!Ctor) return;
    const r = new Ctor();
    rec.current = r;
    r.lang = lang || navigator.language || 'de-DE';
    r.interimResults = true;
    r.continuous = true;
    r.onresult = (event) => {
      let live = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const text = res?.[0]?.transcript ?? '';
        if (res?.isFinal) {
          if (text.trim()) onTextRef.current(text.trim());
        } else {
          live += text;
        }
      }
      setInterim(live.trim());
    };
    r.onend = () => {
      setInterim('');
      setState('idle');
      rec.current = null;
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        onErrorRef.current?.('Microphone access denied');
      } else if (e.error && e.error !== 'no-speech' && e.error !== 'aborted') {
        onErrorRef.current?.(`Dictation error: ${e.error}`);
      }
    };
    try {
      r.start();
      setState('listening');
      haptic('medium');
    } catch {
      setState('idle');
    }
  };

  const startServer = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported?.(m));
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const ctx = { recorder, stream, chunks: [] as Blob[], cancelled: false };
      media.current = ctx;
      recorder.ondataavailable = (e) => {
        if (e.data.size) ctx.chunks.push(e.data);
      };
      recorder.onstop = async () => {
        const blob = new Blob(ctx.chunks, { type: recorder.mimeType || mime || 'audio/webm' });
        cleanupMedia();
        if (ctx.cancelled || blob.size < 1200) {
          setState('idle');
          return;
        }
        setState('transcribing');
        try {
          const { text } = await api.transcribe(blob, lang || navigator.language);
          if (text.trim()) onTextRef.current(text.trim());
          haptic('light');
        } catch (err) {
          onErrorRef.current?.(err instanceof Error ? err.message : 'Transcription failed');
        } finally {
          setState('idle');
        }
      };
      recorder.start(1000);
      setSeconds(0);
      const started = Date.now();
      tick.current = window.setInterval(() => {
        const s = Math.floor((Date.now() - started) / 1000);
        setSeconds(s);
        if (s >= 180) recorder.stop(); // hard cap: 3 minutes
      }, 250);
      setState('recording');
      haptic('medium');
    } catch {
      cleanupMedia();
      setState('idle');
      onErrorRef.current?.('Microphone access denied');
    }
  };

  const stop = useCallback(() => {
    if (rec.current) rec.current.stop();
    if (media.current && media.current.recorder.state !== 'inactive') media.current.recorder.stop();
  }, []);

  const cancel = useCallback(() => {
    rec.current?.abort();
    if (media.current) {
      media.current.cancelled = true;
      if (media.current.recorder.state !== 'inactive') media.current.recorder.stop();
    }
    setInterim('');
  }, []);

  const toggle = () => {
    if (state === 'transcribing') return;
    if (state !== 'idle') {
      stop();
      return;
    }
    if (useDevice) startDevice();
    else if (useServer) void startServer();
    else onErrorRef.current?.('No dictation engine available — configure Whisper on the server (Settings → Dictation).');
  };

  return { state, interim, supported, seconds, toggle, stop, cancel };
}

/**
 * Server-side dictation: turns a short voice recording from the phone into
 * text. Used when the device has no on-board speech recognizer (Capacitor
 * WebView, Firefox) or when the user prefers Whisper quality.
 *
 * Providers (first configured wins in `auto`):
 *   command — any local CLI, e.g. whisper.cpp:
 *             "whisper-cli -m ~/models/ggml-base.bin -nt -l auto -f {wav}"
 *             ({wav} = 16 kHz mono WAV via ffmpeg, {file} = original upload)
 *   openai  — OpenAI-compatible /audio/transcriptions (OPENAI_API_KEY)
 *   groq    — Groq Whisper (GROQ_API_KEY), fast and cheap
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { VoiceStatus } from '@agentdeck/shared';
import type { Config } from '../config.js';
import type { Logger } from '../logging.js';
import { expandHome } from '../util/paths.js';
import { findExecutable } from '../term/presets.js';

const TIMEOUT_MS = 90_000;

export class VoiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

type Resolved =
  | { provider: 'command'; command: string }
  | { provider: 'openai' | 'groq'; apiKey: string; baseUrl: string; model: string };

export class VoiceService {
  constructor(private readonly deps: { config: Config; log: Logger; env?: Record<string, string | undefined> }) {}

  private resolve(): Resolved | { reason: string } {
    const v = this.deps.config.voice;
    const env = this.deps.env ?? process.env;
    if (v.provider === 'off') return { reason: 'Dictation is disabled in the server config.' };
    const wants = (p: string) => v.provider === 'auto' || v.provider === p;
    if (wants('command') && v.command.trim()) return { provider: 'command', command: v.command.trim() };
    const openaiKey = v.apiKey || env.OPENAI_API_KEY;
    if (wants('openai') && openaiKey) {
      return {
        provider: 'openai',
        apiKey: openaiKey,
        baseUrl: (v.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, ''),
        model: v.model || 'whisper-1',
      };
    }
    const groqKey = (v.provider === 'groq' ? v.apiKey : '') || env.GROQ_API_KEY;
    if (wants('groq') && groqKey) {
      return {
        provider: 'groq',
        apiKey: groqKey,
        baseUrl: 'https://api.groq.com/openai/v1',
        model: v.model || 'whisper-large-v3-turbo',
      };
    }
    return {
      reason:
        'No transcription backend configured. Set OPENAI_API_KEY / GROQ_API_KEY or voice.command (e.g. whisper.cpp) on the server.',
    };
  }

  status(): VoiceStatus {
    const r = this.resolve();
    if ('reason' in r) return { available: false, reason: r.reason };
    return { available: true, provider: r.provider };
  }

  async transcribe(audio: Buffer, mime: string, language?: string): Promise<string> {
    const r = this.resolve();
    if ('reason' in r) throw new VoiceError(r.reason, 'VOICE_UNAVAILABLE');
    const lang = language?.split('-')[0]?.toLowerCase() || this.deps.config.voice.language || undefined;
    if (r.provider === 'command') return this.viaCommand(r.command, audio, mime, lang);
    return this.viaApi(r, audio, mime, lang);
  }

  private async viaApi(
    r: { provider: 'openai' | 'groq'; apiKey: string; baseUrl: string; model: string },
    audio: Buffer,
    mime: string,
    lang: string | undefined,
  ): Promise<string> {
    const form = new FormData();
    const ext = extFor(mime);
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime || 'audio/webm' }), `dictation.${ext}`);
    form.append('model', r.model);
    form.append('response_format', 'json');
    if (lang && lang !== 'auto') form.append('language', lang);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${r.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${r.apiKey}` },
        body: form,
        signal: ctrl.signal,
      });
      const bodyText = await res.text();
      if (!res.ok) {
        throw new VoiceError(`${r.provider} transcription failed (${res.status}): ${bodyText.slice(0, 300)}`, 'VOICE_FAILED');
      }
      const json = JSON.parse(bodyText) as { text?: string };
      return (json.text ?? '').trim();
    } catch (err) {
      if (err instanceof VoiceError) throw err;
      throw new VoiceError(`Transcription request failed: ${(err as Error).message}`, 'VOICE_FAILED');
    } finally {
      clearTimeout(timer);
    }
  }

  private async viaCommand(template: string, audio: Buffer, mime: string, lang: string | undefined): Promise<string> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentdeck-voice-'));
    try {
      const file = path.join(dir, `in.${extFor(mime)}`);
      await fsp.writeFile(file, audio);
      let wav = '';
      if (template.includes('{wav}')) {
        const ffmpeg = findExecutable('ffmpeg');
        if (!ffmpeg) throw new VoiceError('voice.command uses {wav} but ffmpeg is not installed.', 'VOICE_UNAVAILABLE');
        wav = path.join(dir, 'in.wav');
        const conv = await execa(ffmpeg, ['-y', '-loglevel', 'error', '-i', file, '-ar', '16000', '-ac', '1', wav], {
          reject: false,
          timeout: 30_000,
        });
        if (conv.exitCode !== 0) throw new VoiceError(`ffmpeg failed: ${String(conv.stderr).slice(0, 300)}`, 'VOICE_FAILED');
      }
      // Tokenize the template first, then substitute — paths never get re-split.
      const argv = template
        .trim()
        .split(/\s+/)
        .map((tok) =>
          expandHome(tok)
            .replaceAll('{file}', file)
            .replaceAll('{wav}', wav)
            .replaceAll('{lang}', lang ?? 'auto'),
        );
      const [bin, ...args] = argv;
      if (!bin) throw new VoiceError('voice.command is empty.', 'VOICE_UNAVAILABLE');
      const res = await execa(bin, args, { reject: false, timeout: TIMEOUT_MS, cwd: dir });
      if (res.exitCode !== 0) {
        throw new VoiceError(`Transcriber exited with ${res.exitCode}: ${String(res.stderr).slice(0, 300)}`, 'VOICE_FAILED');
      }
      return cleanTranscript(String(res.stdout));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function extFor(mime: string): string {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  return 'webm';
}

/** Strips whisper.cpp style timestamps ("[00:00.000 --> 00:02.000]") and blank lines. */
export function cleanTranscript(out: string): string {
  return out
    .split('\n')
    .map((l) => l.replace(/^\s*\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

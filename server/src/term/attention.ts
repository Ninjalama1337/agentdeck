/**
 * Detects when a terminal wants the user:
 *
 * - `bell`   — a bare BEL (\x07) outside of OSC sequences (Claude Code's
 *              "terminal_bell" notification channel, most TUIs on prompt)
 * - `notify` — OSC 9 (iTerm2/ConEmu style) or OSC 777;notify (urxvt/Ghostty)
 * - `idle`   — output streamed for a while (agent working) and then stopped
 *              (agent done or waiting for input)
 *
 * Pure logic + timers; the TerminalManager feeds it output/input.
 */
export type AttentionReason = 'bell' | 'notify' | 'idle';

export interface AttentionOptions {
  onAttention: (reason: AttentionReason, text?: string) => void;
  /** Enable the "quiet after work" heuristic. */
  idleNotify: boolean;
  /** Silence needed before a busy terminal counts as waiting. */
  quietMs?: number;
  /** Minimum busy streak before quiet is interesting. */
  minBusyMs?: number;
  /** Minimum gap between two attention events. */
  throttleMs?: number;
  now?: () => number;
}

// OSC: ESC ] ... (BEL | ESC \)
// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

export class AttentionDetector {
  private carry = '';
  private busyStart: number | null = null;
  private lastOutput = 0;
  private lastFired = Number.NEGATIVE_INFINITY;
  private quietTimer: NodeJS.Timeout | null = null;
  private readonly quietMs: number;
  private readonly minBusyMs: number;
  private readonly throttleMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: AttentionOptions) {
    this.quietMs = opts.quietMs ?? 12_000;
    this.minBusyMs = opts.minBusyMs ?? 6_000;
    this.throttleMs = opts.throttleMs ?? 20_000;
    this.now = opts.now ?? Date.now;
  }

  /** Feed one PTY output chunk. */
  output(chunk: string): void {
    const t = this.now();
    this.scan(chunk);
    if (!this.opts.idleNotify) return;
    // A gap > quietMs between chunks starts a fresh busy streak.
    if (this.busyStart === null || t - this.lastOutput > this.quietMs) this.busyStart = t;
    this.lastOutput = t;
    this.armQuiet();
  }

  /** User typed — whatever was waiting got an answer; restart the streak. */
  input(): void {
    this.busyStart = null;
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
  }

  dispose(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
  }

  private scan(chunk: string): void {
    let data = this.carry + chunk;
    this.carry = '';
    // Keep an unterminated OSC for the next chunk so a split title sequence
    // is never mistaken for a bare bell.
    const lastOsc = data.lastIndexOf('\x1b]');
    if (lastOsc >= 0) {
      const tail = data.slice(lastOsc);
      if (!/\x07|\x1b\\/.test(tail) && tail.length < 512) {
        this.carry = tail;
        data = data.slice(0, lastOsc);
      }
    }
    let notifyText: string | undefined;
    let notified = false;
    const stripped = data.replace(OSC_RE, (_m, body: string) => {
      if (body.startsWith('9;') && !/^9;\d+;/.test(body)) {
        // OSC 9;<msg> — but OSC 9;4;… is a progress report, not a message.
        notified = true;
        notifyText = body.slice(2);
      } else if (body.startsWith('777;notify;')) {
        notified = true;
        const [, , title, ...rest] = body.split(';');
        notifyText = [title, rest.join(';')].filter(Boolean).join(': ');
      }
      return '';
    });
    if (notified) this.fire('notify', notifyText);
    else if (stripped.includes('\x07')) this.fire('bell');
  }

  private armQuiet(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    const busyStart = this.busyStart;
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      if (busyStart === null) return;
      if (this.lastOutput - busyStart >= this.minBusyMs) {
        this.busyStart = null;
        this.fire('idle');
      }
    }, this.quietMs);
    this.quietTimer.unref?.();
  }

  private fire(reason: AttentionReason, text?: string): void {
    const t = this.now();
    if (t - this.lastFired < this.throttleMs) return;
    this.lastFired = t;
    // Whatever was pending is now reported — do not double-report as idle.
    this.busyStart = null;
    this.opts.onAttention(reason, text?.trim() || undefined);
  }
}

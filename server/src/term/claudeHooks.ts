/**
 * Claude Code hooks for terminals: the TUI reports "asking" and "finished"
 * itself, the moment it happens, instead of the server guessing from a quiet
 * screen. That guess is late by design (it waits for silence) and blind to
 * permission dialogs — Claude keeps a blinking marker on screen while one is
 * open, so the terminal never goes quiet.
 *
 * A terminal started from the Claude preset gets its own settings file
 * (`claude --settings <file>`) whose hooks POST to the local bridge route.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DeckNotificationState } from '@agentdeck/shared';
import { classifyReply, isLimitError } from '../notify/classify.js';
import { summarize } from '../notify/hub.js';

const HOOK_EVENTS = ['UserPromptSubmit', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure'] as const;
const DETAIL_MAX = 140;

export type ClaudeHookSignal =
  /** Claude took a prompt and works. */
  | { kind: 'working' }
  /**
   * A dialog is about to open. `confirmed` — Claude says it is waiting (its own
   * notification); otherwise the screen has to show the dialog first.
   */
  | { kind: 'ask'; detail?: string; confirmed: boolean }
  /** The turn ended. */
  | { kind: 'result'; state: DeckNotificationState; detail?: string };

function settingsFile(dataDir: string, terminalId: string): string {
  return path.join(dataDir, 'terminal-hooks', `${terminalId}.json`);
}

/** Writes the per-terminal settings file (holds the bridge token, hence 0600) and returns its path. */
export function writeClaudeHookSettings(dataDir: string, terminalId: string, port: number, token: string): string {
  const file = settingsFile(dataDir, terminalId);
  const hook = {
    type: 'http',
    url: `http://127.0.0.1:${port}/api/bridge/terminal-hook/${terminalId}`,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 5,
  };
  const hooks = Object.fromEntries(HOOK_EVENTS.map((event) => [event, [{ hooks: [hook] }]]));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ hooks }), { mode: 0o600 });
  return file;
}

export function removeClaudeHookSettings(dataDir: string, terminalId: string): void {
  fs.rmSync(settingsFile(dataDir, terminalId), { force: true });
}

/** `claude …` → `claude --settings '<file>' …`; any other command is returned unchanged. */
export function withClaudeHooks(command: string, file: string): string {
  const m = /^claude(?=\s|$)/.exec(command);
  if (!m) return command;
  return `claude --settings '${file.replace(/'/g, "'\\''")}'${command.slice(m[0].length)}`;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat;
}

/** What the dialog is about: the command to run, the question asked, the file to change. */
function askDetail(tool: string | undefined, input: Record<string, unknown>): string | undefined {
  if (!tool) return undefined;
  if (tool === 'AskUserQuestion') {
    const first = Array.isArray(input.questions) ? (input.questions[0] as Record<string, unknown> | undefined) : undefined;
    return clip(str(first?.question) ?? 'Claude has a question for you.');
  }
  if (tool === 'ExitPlanMode') return 'The plan is ready — approve it to start.';
  const subject = str(input.command) ?? str(input.file_path) ?? str(input.url) ?? str(input.description);
  return clip(subject ? `${tool}: ${subject}` : `Wants to use ${tool}.`);
}

/** Reads one hook payload. Undefined: nothing the user needs to hear about. */
export function interpretClaudeHook(payload: unknown): ClaudeHookSignal | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  switch (p.hook_event_name) {
    case 'UserPromptSubmit':
      return { kind: 'working' };
    case 'PermissionRequest': {
      const input = p.tool_input && typeof p.tool_input === 'object' ? (p.tool_input as Record<string, unknown>) : {};
      const detail = askDetail(str(p.tool_name), input);
      return { kind: 'ask', confirmed: false, ...(detail ? { detail } : {}) };
    }
    case 'Notification': {
      // idle_prompt repeats what Stop already said a minute earlier.
      if (p.notification_type !== 'permission_prompt' && p.notification_type !== 'elicitation_dialog') return undefined;
      const detail = str(p.message);
      return { kind: 'ask', confirmed: true, ...(detail ? { detail: clip(detail) } : {}) };
    }
    case 'Stop': {
      const reply = str(p.last_assistant_message);
      const verdict = classifyReply(reply);
      const detail = verdict.detail ?? summarize(reply, DETAIL_MAX);
      return { kind: 'result', state: verdict.state, ...(detail ? { detail } : {}) };
    }
    case 'StopFailure': {
      const error = str(p.error);
      const text = str(p.error_details) ?? str(p.last_assistant_message) ?? error;
      const limit = error === 'rate_limit' || error === 'billing_error' || isLimitError(text);
      return { kind: 'result', state: limit ? 'limit' : 'error', ...(text ? { detail: clip(text) } : {}) };
    }
    default:
      return undefined;
  }
}

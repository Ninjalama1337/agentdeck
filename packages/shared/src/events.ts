/**
 * WebSocket event protocol (socket.io) — shared between server and web app.
 */
import type { AgentInfo } from './agents.js';
import type {
  AdminJob,
  ChatMessage,
  DeckNotification,
  DeckNotificationState,
  FileChangeEvent,
  PairRequestInfo,
  Project,
  Routine,
  Session,
  SessionStatus,
  TeamRun,
  TerminalInfo,
  UpdateInfo,
} from './api.js';

/**
 * Normalized agent runtime event. The backend translates every adapter's
 * native stream format (Claude Code stream-json, Codex JSONL, ...) into
 * this union before broadcasting to clients.
 */
export type AgentEvent =
  | { type: 'status'; status: SessionStatus; detail?: string }
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'message'; message: ChatMessage }
  | { type: 'tool-use'; tool: string; summary?: string }
  | { type: 'tool-result'; tool: string; ok: boolean; summary?: string }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
      model?: string;
    }
  | { type: 'raw'; line: string };

export interface ServerToClientEvents {
  /**
   * Live normalized stream for a session. Events of a run carry its id and a
   * counter, matching `SessionDraft.run`/`seq` of GET /api/sessions/:id.
   */
  'session:event': (payload: { sessionId: string; ts: number; event: AgentEvent; run?: string; seq?: number }) => void;
  /** Session metadata changed (status, title, model, ...). */
  'session:update': (payload: { session: Session }) => void;
  'project:update': (payload: { project: Project }) => void;
  'agent:update': (payload: { agent: AgentInfo }) => void;
  'team:update': (payload: { run: TeamRun }) => void;
  'routine:update': (payload: { routine: Routine }) => void;
  'routine:deleted': (payload: { id: string }) => void;
  /** Debounced filesystem changes inside a project (watcher). */
  'files:changed': (payload: { projectId: string; events: FileChangeEvent[] }) => void;
  /** Live agent admin job progress (update/install/login). */
  'admin:job': (payload: { job: AdminJob }) => void;
  /** Server self-update progress (scripts/update.sh output, status). */
  'update:state': (payload: { update: UpdateInfo }) => void;
  /** PTY output chunk (UTF-8) for a terminal. */
  'terminal:data': (payload: { id: string; data: string }) => void;
  /** PTY process ended. */
  'terminal:exit': (payload: { id: string; code: number }) => void;
  /** Terminal list changed (created/killed). */
  'terminal:list': (payload: { terminals: TerminalInfo[] }) => void;
  /** A terminal rang the bell / sent an OSC notification / went quiet after work. */
  'terminal:attention': (payload: {
    id: string;
    reason: 'bell' | 'notify' | 'idle';
    state?: DeckNotificationState;
    text?: string;
  }) => void;
  /** Inbox-worthy event (run finished, terminal waiting, team done). Also sent via Web Push. */
  notification: (payload: { notification: DeckNotification }) => void;
  /** Pairing requests from outside the network that wait for approval (full list). */
  'pair:requests': (payload: { requests: PairRequestInfo[] }) => void;
  notify: (payload: { level: 'info' | 'warn' | 'error'; text: string }) => void;
}

export interface ClientToServerEvents {
  'session:interrupt': (
    payload: { sessionId: string },
    ack: (result: { ok: boolean; message?: string }) => void,
  ) => void;
  'terminal:input': (payload: { id: string; data: string }) => void;
  'terminal:resize': (payload: { id: string; cols: number; rows: number }) => void;
  /** Client viewed the terminal — clears its attention flag. */
  'terminal:seen': (payload: { id: string }) => void;
}

export interface SocketData {
  deviceId: string;
}

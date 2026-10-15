/**
 * Shared dependency bag handed to every route module.
 */
import type { Config } from '../config.js';
import type { Logger } from '../logging.js';
import type { Store } from '../state/store.js';
import type { AgentService } from '../agents/registry.js';
import type { AgentManager } from '../agents/manager.js';
import type { TeamOrchestrator } from '../team/orchestrator.js';
import type { PairingCodeManager } from '../auth/secrets.js';
import type { AttemptLimiter } from '../auth/attemptLimiter.js';
import type { PairRequests } from '../auth/pairRequests.js';
import type { TunnelManager } from '../tunnel/manager.js';
import type { UsageCollector } from '../usage/collector.js';
import type { UsageWatcher } from '../usage/watcher.js';
import type { WorktreeStore } from '../git/worktrees.js';
import type { StatsDb } from '../stats/db.js';
import type { RateLimiter } from '../util/rateLimit.js';
import type { Broadcaster } from '../ws/gateway.js';
import type { FileWatchers } from '../files/watcher.js';
import type { AdminJobRunner } from '../admin/runner.js';
import type { UpdateManager } from '../update/manager.js';
import type { TerminalManager } from '../term/manager.js';
import type { RoutineScheduler } from '../routines/scheduler.js';
import type { NotificationHub } from '../notify/hub.js';
import type { VoiceService } from '../voice/transcribe.js';

export interface AppDeps {
  config: Config;
  log: Logger;
  store: Store;
  agents: AgentService;
  manager: AgentManager;
  teams: TeamOrchestrator;
  usage: UsageCollector;
  /** Parallel agent worktrees (git/worktrees.ts). */
  worktrees: WorktreeStore;
  /** Limit warnings; every usage reading goes through it (and on record). */
  usageWatcher: UsageWatcher;
  /** Calls to routine webhooks per caller. */
  hookLimiter: RateLimiter;
  /** Record of every agent run and of the subscription limits over time. */
  stats: StatsDb;
  pairing: PairingCodeManager;
  limiter: AttemptLimiter;
  /** Failed pairing attempts from outside the LAN, all clients together. */
  remoteLimiter: AttemptLimiter;
  /** Pairing requests from outside the LAN awaiting approval on a paired device. */
  pairRequests: PairRequests;
  tunnel: TunnelManager;
  /** Runs the fixed agent admin recipes (update/install/login), one at a time. */
  adminJobs: AdminJobRunner;
  /** Self-update of this server to the latest GitHub release. */
  update: UpdateManager;
  /** PTY shells for the Code tab. */
  terminals: TerminalManager;
  /** Recurring agent runs ("agents on routines"). */
  routines: RoutineScheduler;
  /** Inbox + Web Push delivery. */
  notifications: NotificationHub;
  /** Server-side dictation (Whisper API / local command). */
  voice: VoiceService;
  jwtSecret: string;
  bridgeToken: string;
  bridgeGuard: (req: import('fastify').FastifyRequest) => Promise<void>;
  broadcast: Broadcaster;
  /** Per-project recursive fs.watchers feeding the `files:changed` stream. */
  fileWatchers: FileWatchers;
  /** Absolute path to the built web app, when present. */
  webDist?: string;
  /** The current pairing code (for the startup banner / status). */
  pairingCode: string;
}

/**
 * Live filesystem watcher: one recursive fs.watch per project, debounced and
 * batched into `files:changed` socket broadcasts.
 *
 * - API-driven writes (PUT content / create / delete) push synthetic events
 *   into the SAME per-project batch, so real watcher events and API events
 *   coalesce (dedupe: one event per path per batch window).
 * - Anything inside `.git/` is never emitted (watcher-side filter AND routes
 *   reject such paths outright).
 * - Failure handling: if `fs.watch` throws (e.g. ENOSPC / recursive watch
 *   unavailable) or the watcher errors out, the project is marked degraded
 *   (no fs events) and ONE silent re-watch is attempted after 2 s — the
 *   server must never crash because of the watcher.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FileChangeEvent, FileChangeEventKind } from '@agentdeck/shared';
import type { Broadcaster } from '../ws/gateway.js';
import type { Logger } from '../logging.js';
import { isGitInternalPath } from './sandbox.js';

/** Debounce window per project; events inside one window collapse to one batch. */
export const FILE_WATCH_DEBOUNCE_MS = 400;
/** Delay before the single silent re-watch attempt after a watcher error. */
const REWATCH_DELAY_MS = 2000;

/**
 * Name prefix of the atomic-write temp dirs created by the edit routes.
 * Watcher events for these transient paths are suppressed so API writes
 * surface exactly one event for the real target path.
 */
export const EDIT_TEMP_PREFIX = '.agentdeck-edit-';

function isEditTempPath(rel: string): boolean {
  return rel.split('/').some((segment) => segment.startsWith(EDIT_TEMP_PREFIX));
}

/** POSIX-ifies a path (fs.watch reports platform separators). */
function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

interface WatchState {
  projectId: string;
  /** Absolute root passed by the caller (fs.watch reports paths relative to it). */
  root: string;
  watcher: fs.FSWatcher | null;
  degraded: boolean;
  /** A re-watch retry has already been scheduled/spent for this failure episode. */
  retryPending: boolean;
  retryTimer: NodeJS.Timeout | null;
  batchTimer: NodeJS.Timeout | null;
  /** Batch window: rel POSIX path → event (deduped, see queue()). */
  batch: Map<string, FileChangeEvent>;
  /** Rel paths observed to exist — drives the create-vs-change heuristic. */
  seen: Set<string>;
}

export interface FileWatchersOptions {
  broadcast: Broadcaster;
  log: Logger;
  /** Override for tests. */
  debounceMs?: number;
}

export class FileWatchers {
  private readonly states = new Map<string, WatchState>();
  private readonly debounceMs: number;

  constructor(private readonly opts: FileWatchersOptions) {
    this.debounceMs = opts.debounceMs ?? FILE_WATCH_DEBOUNCE_MS;
  }

  /**
   * Starts (or keeps) the recursive watcher for a project. Called lazily from
   * the file routes and once per registered project on boot.
   */
  ensureStarted(projectId: string, absRoot: string): void {
    const existing = this.states.get(projectId);
    if (existing) {
      // Root changed (should not happen) or a degraded watcher gets a fresh
      // attempt whenever the project's files are accessed again.
      if (existing.root !== absRoot || (existing.degraded && !existing.retryTimer && !existing.watcher)) {
        this.stop(projectId);
        this.start(projectId, absRoot);
      }
      return;
    }
    this.start(projectId, absRoot);
  }

  /** Stops the watcher for one project (registry delete / shutdown). */
  stop(projectId: string): void {
    const state = this.states.get(projectId);
    if (!state) return;
    this.states.delete(projectId);
    if (state.batchTimer) clearTimeout(state.batchTimer);
    if (state.retryTimer) clearTimeout(state.retryTimer);
    try {
      state.watcher?.close();
    } catch {
      // already closed
    }
  }

  /** Stops every watcher (server shutdown). */
  stopAll(): void {
    for (const projectId of [...this.states.keys()]) this.stop(projectId);
  }

  /**
   * Feeds an API-driven (authoritative) event into the same batch pipeline as
   * fs events, so debounce coalesces both and clients see one stream.
   */
  push(projectId: string, event: FileChangeEvent): void {
    const state = this.states.get(projectId);
    if (!state || isGitInternalPath(event.path)) return;
    if (event.type === 'delete') state.seen.delete(event.path);
    else state.seen.add(event.path);
    this.queue(state, event, { authoritative: true });
  }

  // -----------------------------------------------------------------------

  private start(projectId: string, absRoot: string): void {
    const state: WatchState = {
      projectId,
      root: absRoot,
      watcher: null,
      degraded: false,
      retryPending: false,
      retryTimer: null,
      batchTimer: null,
      batch: new Map(),
      seen: new Set(),
    };
    this.states.set(projectId, state);
    this.openWatcher(state);
  }

  private openWatcher(state: WatchState): void {
    try {
      const watcher = fs.watch(state.root, { recursive: true, persistent: false });
      watcher.on('change', (eventType: string, filename: string | Buffer) => {
        const type: fs.WatchEventType = eventType === 'change' ? 'change' : 'rename';
        this.onFsEvent(state, type, filename);
      });
      watcher.on('error', (err) => this.onWatcherError(state, err));
      state.watcher = watcher;
      state.degraded = false;
      state.retryPending = false;
    } catch (err) {
      this.degrade(state, err);
    }
  }

  private onWatcherError(state: WatchState, err: Error): void {
    if (this.states.get(state.projectId) !== state) return;
    this.degrade(state, err);
  }

  /** Marks the project degraded and schedules the ONE silent re-watch attempt. */
  private degrade(state: WatchState, err: unknown): void {
    state.degraded = true;
    try {
      state.watcher?.close();
    } catch {
      // already closed
    }
    state.watcher = null;
    this.opts.log.warn(
      { err, projectId: state.projectId, root: state.root },
      'file watcher degraded — no live fs events for this project',
    );
    if (!state.retryPending) {
      state.retryPending = true;
      const timer = setTimeout(() => {
        state.retryTimer = null;
        if (this.states.get(state.projectId) !== state) return;
        this.openWatcher(state); // a second failure stays degraded (no loop)
      }, REWATCH_DELAY_MS);
      timer.unref?.();
      state.retryTimer = timer;
    }
  }

  private onFsEvent(
    state: WatchState,
    eventType: fs.WatchEventType,
    filename: string | Buffer | null,
  ): void {
    if (this.states.get(state.projectId) !== state) return;
    if (filename === null) return;
    const name = typeof filename === 'string' ? filename : filename.toString('utf8');
    if (name === '') return;
    const rawRel = path.isAbsolute(name) ? path.relative(state.root, name) : name;
    if (rawRel === '' || rawRel.startsWith('..') || path.isAbsolute(rawRel)) return;
    const rel = toPosix(rawRel);
    if (isGitInternalPath(rel) || isEditTempPath(rel)) return;
    // Classify asynchronously (existence check) — fs.watch callbacks stay sync.
    void this.classifyAndQueue(state, rel, eventType);
  }

  /** rename+exists → create/change (via seen-set), rename+missing → delete. */
  private async classifyAndQueue(
    state: WatchState,
    rel: string,
    eventType: fs.WatchEventType,
  ): Promise<void> {
    if (this.states.get(state.projectId) !== state) return;
    let type: FileChangeEventKind;
    if (eventType === 'change') {
      type = 'change';
      state.seen.add(rel);
    } else {
      let exists = false;
      try {
        const stats = await fsp.stat(path.join(state.root, rel));
        exists = stats.isFile() || stats.isDirectory();
      } catch {
        exists = false;
      }
      if (this.states.get(state.projectId) !== state) return;
      if (exists) {
        type = state.seen.has(rel) ? 'change' : 'create';
        state.seen.add(rel);
      } else {
        type = 'delete';
        state.seen.delete(rel);
      }
    }
    // Non-authoritative fs events must not overwrite an API event already in
    // the batch for the same path (except `delete`, which is conclusive).
    const existing = state.batch.get(rel);
    if (existing && type !== 'delete') return;
    this.queue(state, { type, path: rel });
  }

  /** Adds to the batch and (re)arms the trailing debounce timer. */
  private queue(state: WatchState, event: FileChangeEvent, opts: { authoritative?: boolean } = {}): void {
    const existing = state.batch.get(event.path);
    if (existing && !opts.authoritative && event.type !== 'delete') return;
    state.batch.set(event.path, event);
    if (state.batchTimer) clearTimeout(state.batchTimer);
    const timer = setTimeout(() => this.flush(state), this.debounceMs);
    timer.unref?.();
    state.batchTimer = timer;
  }

  private flush(state: WatchState): void {
    state.batchTimer = null;
    if (this.states.get(state.projectId) !== state) return;
    if (state.batch.size === 0) return;
    const events = [...state.batch.values()];
    state.batch.clear();
    this.opts.broadcast('files:changed', { projectId: state.projectId, events });
  }
}

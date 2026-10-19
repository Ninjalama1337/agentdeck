/**
 * Live filesystem watcher: one recursive watch per project, debounced and
 * batched into `files:changed` socket broadcasts. On Linux it watches folders
 * only and skips dependency trees (see treeWatch.ts); elsewhere the native
 * recursive fs.watch is cheap.
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
import { watchTree, type TreeWatcher } from './treeWatch.js';

/** Debounce window per project; events inside one window collapse to one batch. */
export const FILE_WATCH_DEBOUNCE_MS = 400;
/** Delay before the single silent re-watch attempt after a watcher error. */
const REWATCH_DELAY_MS = 2000;
/**
 * How long after a watcher starts a `change` without a birth time may still be
 * a create whose `rename` was missed. Filesystems without birth-time support
 * (where Node reports the ctime instead) use this window.
 */
const MISSED_RENAME_GRACE_MS = 5000;

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

/**
 * Whether `stats` describes a path created after the watcher started. Used for
 * `change` events on paths we have never seen: a missed `rename` means a new
 * file, while an edit of a file that predates the watcher must stay a change.
 *
 * `birthtime` is trusted only when it predates `ctime`: Node falls back to the
 * ctime on filesystems without birth-time support, and a ctime that just moved
 * would make every edit look like a creation. In that case the short grace
 * window after start covers the missed-rename race instead.
 */
function createdSince(stats: fs.Stats, startedAt: number): boolean {
  if (stats.birthtimeMs > 0 && stats.birthtimeMs < stats.ctimeMs) {
    return stats.birthtimeMs >= startedAt;
  }
  return Date.now() - startedAt <= MISSED_RENAME_GRACE_MS;
}

interface WatchState {
  projectId: string;
  /** Absolute root passed by the caller (fs.watch reports paths relative to it). */
  root: string;
  watcher: TreeWatcher | null;
  degraded: boolean;
  /** A re-watch retry has already been scheduled/spent for this failure episode. */
  retryPending: boolean;
  retryTimer: NodeJS.Timeout | null;
  batchTimer: NodeJS.Timeout | null;
  /** Batch window: rel POSIX path → event (deduped, see queue()). */
  batch: Map<string, FileChangeEvent>;
  /** Rel paths observed to exist — drives the create-vs-change heuristic. */
  seen: Set<string>;
  /** Rel paths whose first-event existence check is still running. */
  classifying: Map<string, number>;
  /** Wall-clock time the watcher was opened; separates new files from old ones. */
  startedAt: number;
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
      classifying: new Map(),
      startedAt: Date.now(),
    };
    this.states.set(projectId, state);
    this.openWatcher(state);
  }

  private openWatcher(state: WatchState): void {
    try {
      state.watcher = process.platform === 'linux' ? this.openTree(state) : this.openNative(state);
      state.degraded = false;
      state.retryPending = false;
    } catch (err) {
      this.degrade(state, err);
    }
  }

  private openTree(state: WatchState): TreeWatcher {
    return watchTree(state.root, {
      onChange: (type, rel) => this.onFsEvent(state, type, rel),
      onError: (err) => this.onWatcherError(state, err),
      onCapped: () =>
        this.opts.log.warn(
          { projectId: state.projectId, root: state.root },
          'file watcher capped — folders beyond the limit get no live fs events',
        ),
    });
  }

  private openNative(state: WatchState): TreeWatcher {
    const watcher = fs.watch(state.root, { recursive: true, persistent: false });
    watcher.on('change', (eventType: string, filename: string | Buffer) => {
      const type: fs.WatchEventType = eventType === 'change' ? 'change' : 'rename';
      this.onFsEvent(state, type, filename);
    });
    watcher.on('error', (err) => this.onWatcherError(state, err));
    return watcher;
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

  /**
   * rename+exists → create/change (via seen-set), rename+missing → delete.
   * A `change` for a path we have never classified counts as its first event
   * too: on a slow machine a new file's `rename` can be missed entirely, and
   * then only its `change` shows up. The disk decides, but the birth time
   * keeps edits of files that predate the watcher a `change`.
   */
  private async classifyAndQueue(
    state: WatchState,
    rel: string,
    eventType: fs.WatchEventType,
  ): Promise<void> {
    if (this.states.get(state.projectId) !== state) return;
    let type: FileChangeEventKind;
    if (eventType === 'change' && state.seen.has(rel)) {
      // A path we already know, reported as changed: a plain edit.
      type = 'change';
    } else {
      // A classification for this path is still running — let it decide.
      if (state.classifying.has(rel)) return;
      state.classifying.set(rel, (state.classifying.get(rel) ?? 0) + 1);
      let exists = false;
      let stats: fs.Stats | null = null;
      try {
        stats = await fsp.stat(path.join(state.root, rel));
        exists = stats.isFile() || stats.isDirectory();
      } catch {
        exists = false;
      } finally {
        const pending = (state.classifying.get(rel) ?? 1) - 1;
        if (pending > 0) state.classifying.set(rel, pending);
        else state.classifying.delete(rel);
      }
      if (this.states.get(state.projectId) !== state) return;
      if (exists) {
        if (state.seen.has(rel)) {
          type = 'change';
        } else if (eventType === 'change' && stats && !createdSince(stats, state.startedAt)) {
          // The file existed before this watcher started: first edit, not a
          // create whose rename went missing.
          type = 'change';
        } else {
          type = 'create';
        }
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

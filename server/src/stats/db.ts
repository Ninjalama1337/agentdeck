/**
 * StatsDb: the record of every agent run — who (agent, model) did what
 * (project, session, routine, terminal), how long, with how many tokens and at
 * what cost — plus the subscription limits over time. One SQLite file in the
 * data dir (`stats.sqlite`, Node's built-in `node:sqlite`).
 *
 * Without SQLite (Node < 22.13) the server runs as before; `available` is
 * false and nothing is kept.
 */
import path from 'node:path';
import type {
  AgentUsage,
  PlanSnapshot,
  RunListResponse,
  RunRecord,
  StatsBucket,
  StatsResponse,
} from '@agentdeck/shared';
import type { Logger } from '../logging.js';

type SqlValue = string | number | null;

/** The slice of `node:sqlite` used here. */
interface Db {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: SqlValue[]): unknown;
    get(...params: SqlValue[]): Record<string, SqlValue> | undefined;
    all(...params: SqlValue[]): Record<string, SqlValue>[];
  };
  close(): void;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    model TEXT,
    project_id TEXT,
    project_name TEXT,
    session_id TEXT,
    terminal_id TEXT,
    routine_id TEXT,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    title TEXT,
    summary TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    cost_usd REAL,
    tool_calls INTEGER
  );
  CREATE INDEX IF NOT EXISTS runs_started ON runs (started_at);
  CREATE INDEX IF NOT EXISTS runs_routine ON runs (routine_id, started_at);
  CREATE TABLE IF NOT EXISTS plan_snapshots (
    agent_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    plan TEXT,
    session_pct REAL,
    week_pct REAL,
    session_resets_at TEXT,
    week_resets_at TEXT
  );
  CREATE INDEX IF NOT EXISTS plans_agent ON plan_snapshots (agent_id, ts);
`;

const SUMS = `
  COUNT(*) AS runs,
  SUM(status = 'ok') AS ok,
  SUM(status = 'error') AS errors,
  SUM(status = 'stopped') AS stopped,
  SUM(ended_at - started_at) AS durationMs,
  SUM(COALESCE(input_tokens, 0)) AS inputTokens,
  SUM(COALESCE(output_tokens, 0)) AS outputTokens,
  SUM(COALESCE(cache_read_tokens, 0)) AS cacheReadTokens,
  SUM(COALESCE(cache_write_tokens, 0)) AS cacheWriteTokens,
  SUM(COALESCE(cost_usd, 0)) AS costUsd,
  SUM(COALESCE(tool_calls, 0)) AS toolCalls`;

/** A subscription that did not move is not written again before this much time passed. */
const SNAPSHOT_MIN_GAP_MS = 60 * 60_000;
const TEXT_MAX = 300;

const EMPTY_BUCKET: StatsBucket = {
  runs: 0,
  ok: 0,
  errors: 0,
  stopped: 0,
  durationMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  toolCalls: 0,
};

export interface StatsQuery {
  from: number;
  to: number;
  /** Minutes the caller's clock is ahead of UTC — decides where a day begins. */
  tzOffset?: number;
}

export interface RunListQuery {
  limit?: number;
  /** Only runs that started before this instant. */
  before?: number;
  agentId?: string;
  projectId?: string;
  routineId?: string;
}

function clip(text: string | undefined): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > TEXT_MAX ? `${flat.slice(0, TEXT_MAX - 1)}…` : flat;
}

function bucketOf(row: Record<string, SqlValue> | undefined): StatsBucket {
  const bucket = { ...EMPTY_BUCKET };
  if (!row) return bucket;
  for (const key of Object.keys(bucket) as (keyof StatsBucket)[]) {
    const value = row[key];
    if (typeof value === 'number') bucket[key] = value;
  }
  return bucket;
}

function runOf(row: Record<string, SqlValue>): RunRecord {
  const text = (key: string): string | undefined => (typeof row[key] === 'string' ? (row[key] as string) : undefined);
  const num = (key: string): number | undefined => (typeof row[key] === 'number' ? (row[key] as number) : undefined);
  const record: RunRecord = {
    id: String(row.id),
    startedAt: Number(row.started_at),
    endedAt: Number(row.ended_at),
    agentId: String(row.agent_id),
    source: String(row.source) as RunRecord['source'],
    status: String(row.status) as RunRecord['status'],
  };
  const optional: Partial<RunRecord> = {
    model: text('model'),
    projectId: text('project_id'),
    projectName: text('project_name'),
    sessionId: text('session_id'),
    terminalId: text('terminal_id'),
    routineId: text('routine_id'),
    error: text('error'),
    title: text('title'),
    summary: text('summary'),
    inputTokens: num('input_tokens'),
    outputTokens: num('output_tokens'),
    cacheReadTokens: num('cache_read_tokens'),
    cacheWriteTokens: num('cache_write_tokens'),
    costUsd: num('cost_usd'),
    toolCalls: num('tool_calls'),
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) (record as unknown as Record<string, unknown>)[key] = value;
  }
  return record;
}

function snapshotOf(row: Record<string, SqlValue>): PlanSnapshot {
  return {
    agentId: String(row.agent_id),
    ts: Number(row.ts),
    ...(typeof row.plan === 'string' ? { plan: row.plan } : {}),
    ...(typeof row.session_pct === 'number' ? { sessionPct: row.session_pct } : {}),
    ...(typeof row.week_pct === 'number' ? { weekPct: row.week_pct } : {}),
    ...(typeof row.session_resets_at === 'string' ? { sessionResetsAt: row.session_resets_at } : {}),
    ...(typeof row.week_resets_at === 'string' ? { weekResetsAt: row.week_resets_at } : {}),
  };
}

export class StatsDb {
  private db: Db | undefined;
  private reason: string | undefined;

  private constructor(private readonly log?: Logger) {}

  /** Opens (and creates) the database. `file` may be ':memory:'. Never throws. */
  static async open(file: string, log?: Logger): Promise<StatsDb> {
    const stats = new StatsDb(log);
    try {
      const { DatabaseSync } = (await import('node:sqlite')) as unknown as { DatabaseSync: new (file: string) => Db };
      const db = new DatabaseSync(file);
      if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
      db.exec(SCHEMA);
      stats.db = db;
    } catch (err) {
      stats.reason = `The activity database needs Node 22.13 or newer (${(err as Error).message}).`;
      log?.warn({ err: (err as Error).message }, 'activity database unavailable');
    }
    return stats;
  }

  static fileIn(dataDir: string): string {
    return path.join(dataDir, 'stats.sqlite');
  }

  get available(): boolean {
    return this.db !== undefined;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // already closed
    }
    this.db = undefined;
  }

  /** Keeps one finished run. A failure here must never fail the run itself. */
  recordRun(run: RunRecord): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO runs (id, started_at, ended_at, agent_id, model, project_id, project_name, session_id,
             terminal_id, routine_id, source, status, error, title, summary, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, cost_usd, tool_calls)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.startedAt,
          Math.max(run.endedAt, run.startedAt),
          run.agentId,
          run.model ?? null,
          run.projectId ?? null,
          run.projectName ?? null,
          run.sessionId ?? null,
          run.terminalId ?? null,
          run.routineId ?? null,
          run.source,
          run.status,
          clip(run.error),
          clip(run.title),
          clip(run.summary),
          run.inputTokens ?? null,
          run.outputTokens ?? null,
          run.cacheReadTokens ?? null,
          run.cacheWriteTokens ?? null,
          run.costUsd ?? null,
          run.toolCalls ?? null,
        );
    } catch (err) {
      this.log?.warn({ err: (err as Error).message }, 'could not record run');
    }
  }

  /** Keeps the subscription limits just read — once they moved, or once an hour. */
  recordPlans(usages: AgentUsage[], now = Date.now()): void {
    if (!this.db) return;
    try {
      for (const usage of usages) {
        if (!usage.available) continue;
        const sessionPct = usage.session?.pct ?? null;
        const weekPct = usage.week?.pct ?? null;
        if (sessionPct === null && weekPct === null && !usage.plan) continue;
        const last = this.db
          .prepare('SELECT ts, plan, session_pct, week_pct FROM plan_snapshots WHERE agent_id = ? ORDER BY ts DESC LIMIT 1')
          .get(usage.agentId);
        const same =
          last !== undefined &&
          last.session_pct === sessionPct &&
          last.week_pct === weekPct &&
          (last.plan ?? null) === (usage.plan ?? null);
        if (same && now - Number(last.ts) < SNAPSHOT_MIN_GAP_MS) continue;
        this.db
          .prepare(
            `INSERT INTO plan_snapshots (agent_id, ts, plan, session_pct, week_pct, session_resets_at, week_resets_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(usage.agentId, now, usage.plan ?? null, sessionPct, weekPct, usage.session?.resetsAt ?? null, usage.week?.resetsAt ?? null);
      }
    } catch (err) {
      this.log?.warn({ err: (err as Error).message }, 'could not record plan usage');
    }
  }

  summary(query: StatsQuery): StatsResponse {
    const { from, to } = query;
    const empty: StatsResponse = {
      available: this.db !== undefined,
      ...(this.reason ? { reason: this.reason } : {}),
      from,
      to,
      totals: { ...EMPTY_BUCKET },
      byAgent: [],
      byModel: [],
      byProject: [],
      bySource: [],
      byDay: [],
      plans: [],
      planHistory: [],
    };
    const db = this.db;
    if (!db) return empty;
    const where = 'WHERE started_at >= ? AND started_at < ?';
    /** `groupBy`: how many of the leading columns form the group (the rest are aggregates). */
    const grouped = <K extends string>(columns: string, keys: readonly K[], order = 'runs DESC, 1', groupBy = keys.length) =>
      db
        .prepare(
          `SELECT ${columns}, ${SUMS} FROM runs ${where}
           GROUP BY ${keys.slice(0, groupBy).map((_, i) => i + 1).join(', ')} ORDER BY ${order}`,
        )
        .all(from, to)
        .map((row) => ({
          ...bucketOf(row),
          ...(Object.fromEntries(keys.map((k) => [k, String(row[k] ?? '')])) as Record<K, string>),
        }));
    const offsetSec = Math.round((query.tzOffset ?? 0) * 60);
    const day = `strftime('%Y-%m-%d', started_at / 1000 + ${offsetSec}, 'unixepoch')`;
    const first = db.prepare('SELECT MIN(started_at) AS first FROM runs').get();
    return {
      ...empty,
      totals: bucketOf(db.prepare(`SELECT ${SUMS} FROM runs ${where}`).get(from, to)),
      byAgent: grouped('agent_id AS agentId', ['agentId'] as const),
      byModel: grouped("agent_id AS agentId, COALESCE(model, '') AS model", ['agentId', 'model'] as const),
      byProject: grouped(
        "COALESCE(project_id, '') AS projectId, COALESCE(MAX(project_name), '') AS projectName",
        ['projectId', 'projectName'] as const,
        'runs DESC, 1',
        1,
      ),
      bySource: grouped('source', ['source'] as const) as StatsResponse['bySource'],
      byDay: grouped(`${day} AS day, agent_id AS agentId`, ['day', 'agentId'] as const, 'day ASC, agentId ASC'),
      plans: db
        .prepare(
          `SELECT p.* FROM plan_snapshots p
           JOIN (SELECT agent_id, MAX(ts) AS ts FROM plan_snapshots GROUP BY agent_id) latest
             ON latest.agent_id = p.agent_id AND latest.ts = p.ts
           ORDER BY p.agent_id`,
        )
        .all()
        .map(snapshotOf),
      planHistory: db
        .prepare(
          `SELECT p.* FROM plan_snapshots p
           JOIN (SELECT agent_id, MAX(ts) AS ts FROM plan_snapshots WHERE ts >= ? AND ts < ?
                 GROUP BY agent_id, ts / 3600000) hourly
             ON hourly.agent_id = p.agent_id AND hourly.ts = p.ts
           ORDER BY p.ts`,
        )
        .all(from, to)
        .map(snapshotOf),
      ...(typeof first?.first === 'number' ? { firstRunAt: first.first } : {}),
    };
  }

  /** Runs, newest first. */
  runs(query: RunListQuery = {}): RunListResponse {
    if (!this.db) return { runs: [] };
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const conditions: string[] = [];
    const params: SqlValue[] = [];
    const add = (sql: string, value: SqlValue | undefined) => {
      if (value === undefined) return;
      conditions.push(sql);
      params.push(value);
    };
    add('started_at < ?', query.before);
    add('agent_id = ?', query.agentId);
    add('project_id = ?', query.projectId);
    add('routine_id = ?', query.routineId);
    const rows = this.db
      .prepare(
        `SELECT * FROM runs ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(...params, limit + 1);
    const page = rows.slice(0, limit).map(runOf);
    const last = page[page.length - 1];
    return { runs: page, ...(rows.length > limit && last ? { next: last.startedAt } : {}) };
  }
}

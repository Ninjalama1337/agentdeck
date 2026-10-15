/**
 * Daily digest: what the agents did today — runs, tokens and cost per agent
 * and project from the stats database, plus the commits of the day — as a
 * card in the app and once in the evening as a notification.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import type { DailySummary, DigestSettings, Project } from '@agentdeck/shared';
import { AGENT_LABELS } from '@agentdeck/shared';
import type { StatsDb } from './db.js';

const DEFAULT_SETTINGS: DigestSettings = { enabled: true, time: '20:00' };
const MAX_PROJECTS = 30;

/** Midnight of `now`'s day for a clock `tzOffset` minutes ahead of UTC. */
export function startOfDay(now: number, tzOffset: number): number {
  const local = now + tzOffset * 60_000;
  return local - (local % 86_400_000) - tzOffset * 60_000;
}

export function dayKey(now: number, tzOffset: number): string {
  return new Date(now + tzOffset * 60_000).toISOString().slice(0, 10);
}

/** Server's own offset (minutes ahead of UTC). */
export function serverTzOffset(now = Date.now()): number {
  return -new Date(now).getTimezoneOffset();
}

async function commitsSince(projectPath: string, since: number): Promise<string[]> {
  const res = await execa('git', ['-C', projectPath, 'log', '--all', `--since=@${Math.floor(since / 1000)}`, '--no-merges', '--format=%s', '-n', '50'], {
    reject: false,
    timeout: 10_000,
  });
  return res.exitCode === 0 ? String(res.stdout).split('\n').filter(Boolean) : [];
}

export async function buildDailySummary(
  stats: StatsDb,
  projects: Project[],
  now = Date.now(),
  tzOffset = serverTzOffset(now),
): Promise<DailySummary> {
  const from = startOfDay(now, tzOffset);
  const s = stats.summary({ from, to: now, tzOffset });
  const runs = stats.runs({ limit: 200 }).runs.filter((r) => r.startedAt >= from);
  const commits: DailySummary['commits'] = [];
  for (const p of projects.slice(0, MAX_PROJECTS)) {
    const subjects = await commitsSince(p.path, from).catch(() => []);
    if (subjects.length) commits.push({ projectId: p.id, projectName: p.name, count: subjects.length, subjects: subjects.slice(0, 5) });
  }
  commits.sort((a, b) => b.count - a.count);
  const highlights = runs
    .filter((r) => r.title)
    .slice(0, 6)
    .map((r) => ({ agentId: r.agentId, title: r.title!, status: r.status, ...(r.projectName ? { projectName: r.projectName } : {}) }));
  return {
    day: dayKey(now, tzOffset),
    from,
    to: now,
    totals: s.totals,
    byAgent: [...s.byAgent].sort((a, b) => b.runs - a.runs),
    byProject: [...s.byProject].sort((a, b) => b.runs - a.runs),
    commits,
    highlights,
  };
}

/** Notification text, or null for a quiet day. */
export function digestText(d: DailySummary): { title: string; body: string } | null {
  const commitCount = d.commits.reduce((n, c) => n + c.count, 0);
  if (d.totals.runs === 0 && commitCount === 0) return null;
  const parts: string[] = [];
  if (d.byAgent.length) {
    parts.push(d.byAgent.slice(0, 3).map((a) => `${AGENT_LABELS[a.agentId as keyof typeof AGENT_LABELS] ?? a.agentId} ${a.runs}`).join(' · '));
  }
  if (d.commits.length) parts.push(d.commits.slice(0, 3).map((c) => `${c.projectName}: ${c.count} ${c.count === 1 ? 'commit' : 'commits'}`).join(', '));
  if (d.totals.errors) parts.push(`${d.totals.errors} failed`);
  if (d.totals.costUsd >= 0.01) parts.push(`≈ $${d.totals.costUsd.toFixed(2)} API value`);
  const runsText = `${d.totals.runs} ${d.totals.runs === 1 ? 'run' : 'runs'}`;
  const commitsText = `${commitCount} ${commitCount === 1 ? 'commit' : 'commits'}`;
  return { title: `Today: ${runsText}, ${commitsText}`, body: parts.join(' — ') };
}

export interface DigestSchedulerOptions {
  dataDir: string;
  build(now: number): Promise<DailySummary>;
  notify(text: { title: string; body: string }): void;
  now?: () => number;
  log: { warn(obj: object, msg?: string): void };
}

/** Sends the digest once a day at the set time (server's clock). */
export class DigestScheduler {
  private settings: DigestSettings;
  private timer: NodeJS.Timeout | null = null;
  private readonly file: string;
  private running = false;

  constructor(private readonly opts: DigestSchedulerOptions) {
    this.file = path.join(opts.dataDir, 'digest.json');
    let saved: Partial<DigestSettings> = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<DigestSettings>;
    } catch {
      /* defaults */
    }
    this.settings = {
      enabled: typeof saved.enabled === 'boolean' ? saved.enabled : DEFAULT_SETTINGS.enabled,
      time: typeof saved.time === 'string' && /^\d{2}:\d{2}$/.test(saved.time) ? saved.time : DEFAULT_SETTINGS.time,
      ...(typeof saved.lastSent === 'string' ? { lastSent: saved.lastSent } : {}),
    };
  }

  get(): DigestSettings {
    return { ...this.settings };
  }

  set(update: Partial<Pick<DigestSettings, 'enabled' | 'time'>>): DigestSettings {
    this.settings = { ...this.settings, ...update };
    this.save();
    return this.get();
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.settings, null, 2));
    } catch (err) {
      this.opts.log.warn({ err }, 'cannot save digest settings');
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Due once the set time has passed today and today's digest is not out yet. */
  isDue(now: number): boolean {
    if (!this.settings.enabled) return false;
    const offset = serverTzOffset(now);
    const day = dayKey(now, offset);
    if (this.settings.lastSent === day) return false;
    const [h, m] = this.settings.time.split(':').map(Number);
    return now - startOfDay(now, offset) >= ((h ?? 20) * 60 + (m ?? 0)) * 60_000;
  }

  async tick(): Promise<void> {
    const now = (this.opts.now ?? Date.now)();
    if (this.running || !this.isDue(now)) return;
    this.running = true;
    try {
      const summary = await this.opts.build(now);
      const text = digestText(summary);
      if (text) this.opts.notify(text);
      // Quiet days count as sent too — no digest at 23:59 after a late run.
      this.settings.lastSent = dayKey(now, serverTzOffset(now));
      this.save();
    } catch (err) {
      this.opts.log.warn({ err }, 'daily digest failed');
    } finally {
      this.running = false;
    }
  }
}

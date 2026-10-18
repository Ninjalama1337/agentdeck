/**
 * Plan checklists as the agents report them:
 *   Claude   `TodoWrite`   → input.todos[{content, status, activeForm}]
 *   Codex    `update_plan` → {plan: [{step, status}]} (or a `plan` item)
 *   OpenCode `todowrite`   → input.todos[{content, status}]
 * The chat shows the list instead of a generic tool row, so the parse lives in
 * one place and every adapter gets the same shape.
 */
import type { PlanItem, PlanItemStatus } from '@agentdeck/shared';
import { truncate } from './types.js';

/** Tool names that carry a checklist. Compared case-insensitively, without `_`/`-`. */
const PLAN_TOOLS = new Set(['todowrite', 'todo', 'updateplan', 'plan']);

function normalizeTool(name: string): string {
  return name.trim().toLowerCase().replace(/[_-]/g, '');
}

/** True when the tool call is the agent updating its plan (not a plan-mode switch). */
export function isPlanTool(name: string | undefined): boolean {
  return typeof name === 'string' && PLAN_TOOLS.has(normalizeTool(name));
}

const ITEM_MAX = 300;

/** The checklist in a plan tool's input (or a Codex `plan` item), undefined when it carries none. */
export function planItemsOf(input: unknown): PlanItem[] | undefined {
  const list = planArray(input);
  if (!list) return undefined;
  const items: PlanItem[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const text = firstString(entry, ['content', 'text', 'step', 'title', 'description', 'task']);
    if (!text) continue;
    items.push({ text: truncate(text, ITEM_MAX), status: statusOf(entry) });
  }
  return items.length ? items : undefined;
}

function planArray(input: unknown): unknown[] | undefined {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of ['todos', 'plan', 'steps', 'items', 'tasks']) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
  }
  // A Codex `plan` item may carry its steps as `update.plan` or `payload.plan`.
  for (const key of ['update', 'payload']) {
    const nested = obj[key];
    if (nested && typeof nested === 'object') {
      const found = planArray(nested);
      if (found) return found;
    }
  }
  return undefined;
}

function statusOf(entry: Record<string, unknown>): PlanItemStatus {
  if (entry['completed'] === true) return 'completed';
  const raw = typeof entry['status'] === 'string' ? entry['status'].toLowerCase().replace(/[-\s]/g, '_') : '';
  if (raw === 'completed' || raw === 'complete' || raw === 'done' || raw === 'finished') return 'completed';
  if (raw === 'in_progress' || raw === 'running' || raw === 'active' || raw === 'started' || raw === 'doing') {
    return 'in_progress';
  }
  return 'pending';
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

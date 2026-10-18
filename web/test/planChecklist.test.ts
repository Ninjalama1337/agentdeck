import { describe, expect, it } from 'vitest';
import type { PlanItem } from '@agentdeck/shared';
import { planProgress } from '../src/features/chat/PlanChecklist';

const items = (...states: PlanItem['status'][]): PlanItem[] =>
  states.map((status, i) => ({ text: `step ${i}`, status }));

describe('planProgress', () => {
  it('counts done and reports the step in progress', () => {
    const progress = planProgress(items('completed', 'completed', 'in_progress', 'pending'));
    expect(progress.done).toBe(2);
    expect(progress.total).toBe(4);
    expect(progress.pct).toBe(50);
    expect(progress.current).toBe('step 2');
  });

  it('has no current step when nothing is in progress', () => {
    expect(planProgress(items('completed', 'pending')).current).toBeUndefined();
    expect(planProgress(items('completed', 'completed'))).toMatchObject({ done: 2, total: 2, pct: 100 });
  });

  it('is empty for no plan', () => {
    expect(planProgress(undefined)).toEqual({ done: 0, total: 0, pct: 0 });
    expect(planProgress([])).toEqual({ done: 0, total: 0, pct: 0 });
  });
});

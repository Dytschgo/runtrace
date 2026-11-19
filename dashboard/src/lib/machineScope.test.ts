import { describe, expect, it } from 'vitest';
import { windowTokens } from './analytics';
import { toTurn } from './entities';
import type { Entity } from './types';

describe('machine-local token attribution', () => {
  it('keeps same-source thread totals separate while preserving the installation total', () => {
    const turns = ['east', 'west'].map((instance_id, i) => toTurn({
      id: `${instance_id}-turn`, source_id: 'turn', kind: 'model_turn', instance_id,
      thread_id: 'same-thread', run_id: 'same-run', project_id: 'p', occurred_at: '2026-11-08T10:00:00Z',
      data: { total_tokens: i ? 9 : 5, usage_status: 'complete' },
    } as Entity));
    const result = windowTokens(turns, {});
    expect(result.total).toBe(14);
    expect(result.byThread.size).toBe(2);
    expect([...result.byThread.values()].map((v) => v.total).sort((a,b) => a! - b!)).toEqual([5, 9]);
  });
});

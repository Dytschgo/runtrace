import { describe, expect, it } from 'vitest';
import { collectionNotice } from './collection';

const now = Date.parse('2026-11-17T12:00:00Z');
describe('collector freshness independent of HTTP liveness', () => {
  it('reports stale collection and respects a deliberately slower poll', () => {
    const collector = { state: 'synced', last_successful_sync_at: new Date(now - 10 * 60_000).toISOString() };
    expect(collectionNotice(collector, 60, now)?.state).toBe('stale');
    expect(collectionNotice(collector, 300, now)).toBeNull();
    expect(collectionNotice({ state: 'synced', last_successful_sync_at: new Date(now).toISOString() }, 60, now)).toBeNull();
  });
  it('keeps paused, partial, retrying, failed and disabled states explicit', () => {
    for (const state of ['paused', 'partial', 'retrying', 'failed', 'disabled', 'starting']) expect(collectionNotice({ state }, 60, now)?.state).toBe(state);
  });
  it('does not mistake a missing or future clock for fresh collection', () => {
    expect(collectionNotice({ state: 'synced' }, 60, now)?.title).toContain('unknown');
    expect(collectionNotice({ state: 'synced', last_successful_sync_at: new Date(now + 10 * 60_000).toISOString() }, 60, now)?.title).toContain('clock');
  });
});

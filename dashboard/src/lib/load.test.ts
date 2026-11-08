import { describe, expect, it, vi } from 'vitest';
import { dataOf, fromQueries, fromQuery } from './load';

const q = <T,>(o: { data?: T; error?: unknown; isPending?: boolean; isError?: boolean }) => ({
  data: o.data, error: o.error ?? null, isPending: o.isPending ?? (o.data === undefined && !o.isError), isError: !!o.isError,
  refetch: vi.fn(),
}) as never;

describe('load states', () => {
  it('names loading, failed, ready and stale from one query', () => {
    expect(fromQuery(q({ isPending: true })).state).toBe('loading');
    expect(fromQuery(q({ isError: true, error: new Error('x') })).state).toBe('failed');
    expect(fromQuery(q({ data: 3 }))).toEqual({ state: 'ready', data: 3 });
    const stale = fromQuery(q({ data: 3, isError: true, error: new Error('refresh') }));
    expect(stale.state).toBe('ready');
    expect(stale.state === 'ready' && stale.stale?.error).toBeInstanceOf(Error);
  });

  it('never shows a partial sum of several queries as the whole', () => {
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    expect(fromQueries([q({ data: 1 }), q({ isPending: true })], sum).state).toBe('loading');
    expect(fromQueries([q({ data: 1 }), q({ isError: true })], sum).state).toBe('failed');
    expect(dataOf(fromQueries([q({ data: 1 }), q({ data: 2 })], sum))).toBe(3);
  });

  it('retries every query of a failed set', () => {
    const a = q({ data: 1 }), b = q({ isError: true });
    const l = fromQueries([a, b], (xs: number[]) => xs.length);
    if (l.state === 'failed') l.retry();
    expect((a as { refetch: () => void }).refetch).toHaveBeenCalled();
    expect((b as { refetch: () => void }).refetch).toHaveBeenCalled();
  });
});

import type { UseQueryResult } from '@tanstack/react-query';

/**
 * Where a value stands, as one of three states. Every page reads loading, failure and staleness from here instead of
 * combining query flags by hand, which is how a failed or unfinished load used to show up as 0 or as an exact number.
 *
 *   loading  nothing to show yet
 *   failed   the read failed and there is nothing earlier to show; never shown as 0 ("Not loaded")
 *   ready    data to show; `stale` is set when a later refresh failed, so the data is from before that failure
 */
export type Load<T> =
  | { state: 'loading' }
  | { state: 'failed'; error: unknown; retry: () => void }
  | { state: 'ready'; data: T; stale?: { error: unknown; retry: () => void } };

export type LoadState = Load<unknown>['state'];

type QueryLike<T> = Pick<UseQueryResult<T>, 'data' | 'error' | 'isPending' | 'isError' | 'refetch'>;

/** One query. Data that already loaded stays shown when a refresh fails, marked stale. */
export function fromQuery<T>(q: QueryLike<T>): Load<T> {
  const retry = () => { void q.refetch(); };
  if (q.data !== undefined) return q.isError ? { state: 'ready', data: q.data, stale: { error: q.error, retry } } : { state: 'ready', data: q.data };
  if (q.isError) return { state: 'failed', error: q.error, retry };
  return { state: 'loading' };
}

/** Several queries that only mean something together, such as rows picked as a filter and summed. One failure fails
 *  them all and one still loading keeps them all loading, so a partial sum is never shown as the whole. */
export function fromQueries<T, R>(qs: QueryLike<T>[], combine: (data: T[]) => R): Load<R> {
  const loads = qs.map(fromQuery);
  const failed = loads.find((l) => l.state === 'failed');
  if (failed) return { ...failed, retry: () => qs.forEach((q) => { void q.refetch(); }) };
  if (loads.some((l) => l.state === 'loading')) return { state: 'loading' };
  const data = combine(loads.map((l) => (l as Extract<Load<T>, { state: 'ready' }>).data));
  const stale = loads.find((l) => l.state === 'ready' && l.stale);
  return stale && stale.state === 'ready' && stale.stale ? { state: 'ready', data, stale: stale.stale } : { state: 'ready', data };
}

export const isReady = <T>(l: Load<T>): l is Extract<Load<T>, { state: 'ready' }> => l.state === 'ready';
export const dataOf = <T>(l: Load<T>): T | undefined => (l.state === 'ready' ? l.data : undefined);

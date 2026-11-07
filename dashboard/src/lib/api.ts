import type { Envelope } from './types';

export type ApiErrorKind = 'offline' | 'invalid' | 'forbidden' | 'server';

export class ApiError extends Error {
  constructor(public kind: ApiErrorKind, message: string, public status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function getJson<T>(route: string, params?: URLSearchParams, signal?: AbortSignal): Promise<T> {
  const qs = params?.toString();
  const url = `/api/v1/${route}${qs ? `?${qs}` : ''}`;
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError('offline', 'The local analytics service is not responding.');
  }
  if (!res.ok) {
    if (res.status === 400) throw new ApiError('invalid', 'The API could not answer this query. Check the date range or clear filters. If no filters are set, check the service log.', 400);
    if (res.status === 403) throw new ApiError('forbidden', 'The API only accepts loopback requests from its own origin.', 403);
    throw new ApiError('server', `The analytics service returned an error (HTTP ${res.status}).`, res.status);
  }
  try {
    return (await res.json()) as T;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError('server', 'The analytics service returned something other than JSON.', res.status);
  }
}

/** Requests content options an older backend rejects by name, then retries without them. */
export async function getEntities<E>(route: string, params: URLSearchParams, signal?: AbortSignal): Promise<E[]> {
  try {
    return (await getJson<Envelope<E>>(route, params, signal)).data ?? [];
  } catch (e) {
    if (!(e instanceof ApiError && e.kind === 'invalid' && params.has('include_content'))) throw e;
    const plain = new URLSearchParams(params);
    plain.delete('include_content');
    return (await getJson<Envelope<E>>(route, plain, signal)).data ?? [];
  }
}

export interface ScanResult<R> { rows: R[]; complete: boolean; scanned: number; failed?: boolean }

const SMALLEST_PAGE = 50;

/**
 * How many full pages are asked for at once after the first comes back full. A big page already holds most histories,
 * and each read costs the service about the same at any size, so big pages look ahead less.
 */
const ahead = (pageSize: number) => (pageSize >= 2_000 ? 2 : 4);

/**
 * Reads newest-first pages up to a row limit. `complete` is false when older rows were left unread.
 * Once a page comes back full, the next few are asked for together, which is most of the wait on a long history.
 * A record that lands on two pages because new ones arrived meanwhile is kept once.
 * A failed page is retried smaller, one at a time, because a page of large records can exceed the service's
 * query memory, and the size recovers afterwards. Once rows are in hand, a page that still fails ends the
 * scan as partial rather than discarding them.
 */
export async function scanPages<E, R>(
  route: string, params: URLSearchParams, map: (e: E) => R, max: number, signal?: AbortSignal, pageSize = 500, onProgress?: (rows: number) => void,
): Promise<ScanResult<R>> {
  const rows: R[] = [];
  const ids = new Set<string>();
  const take = (page: E[]) => {
    for (const e of page) {
      const id = (e as { id?: unknown }).id;
      if (typeof id === 'string') { if (ids.has(id)) continue; ids.add(id); }
      rows.push(map(e));
    }
  };
  const ask = (offset: number, limit: number) => {
    const p = new URLSearchParams(params);
    p.set('limit', String(limit));
    p.set('offset', String(offset));
    return getJson<Envelope<E>>(route, p, signal);
  };
  let offset = 0;
  let size = pageSize;
  let full = 0;
  for (;;) {
    // Ahead of time only at the full page size, and only while nothing has failed.
    if (full > 0 && size === pageSize && max - rows.length > pageSize) {
      const count = Math.min(ahead(pageSize), Math.ceil((max - rows.length) / pageSize));
      const batch = await Promise.allSettled(Array.from({ length: count }, (_, i) => ask(offset + i * pageSize, pageSize)));
      let ended = false;
      for (const result of batch) {
        if (result.status === 'rejected') break;
        const page = result.value.data ?? [];
        take(page);
        offset += page.length;
        if (page.length < pageSize) { ended = true; break; }
      }
      onProgress?.(rows.length);
      if (ended) return { rows, complete: true, scanned: rows.length };
      if (rows.length >= max) return { rows: rows.slice(0, max), complete: false, scanned: max };
      if (batch.some((r) => r.status === 'rejected')) full = 0;
      continue;
    }
    const limit = Math.min(size, Math.max(1, max - rows.length));
    const p = new URLSearchParams(params);
    p.set('limit', String(limit));
    p.set('offset', String(offset));
    let env: Envelope<E>;
    try {
      env = await getJson<Envelope<E>>(route, p, signal);
    } catch (e) {
      if (!(e instanceof ApiError) || e.kind === 'offline' || e.kind === 'forbidden') throw e;
      if (limit > SMALLEST_PAGE) { size = Math.max(SMALLEST_PAGE, Math.floor(limit / 4)); continue; }
      if (rows.length) return { rows, complete: false, scanned: rows.length, failed: true };
      throw e;
    }
    const page = env.data ?? [];
    take(page);
    offset += page.length;
    onProgress?.(rows.length);
    size = Math.min(pageSize, size * 2);
    if (page.length < limit) return { rows, complete: true, scanned: rows.length };
    full += 1;
    if (rows.length >= max) return { rows, complete: false, scanned: rows.length };
  }
}

/** The hourly endpoint caps at 500 ascending rows, which would drop the newest hours, so this walks forward until the end. */
export async function scanHourly<T extends { hour: string }>(params: URLSearchParams, signal?: AbortSignal, route = 'activity/hourly'): Promise<T[]> {
  const out: T[] = [];
  let since = params.get('since');
  for (let i = 0; i < 24; i++) {
    const p = new URLSearchParams(params);
    if (since) p.set('since', since);
    const env = await getJson<Envelope<T>>(route, p, signal);
    const page = env.data ?? [];
    out.push(...page);
    if (page.length < 500) break;
    since = new Date(Date.parse(page[page.length - 1].hour) + 3_600_000).toISOString();
  }
  return out;
}

export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  // Spreadsheet formula prefixes are neutralised because cells can hold captured text.
  const cell = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

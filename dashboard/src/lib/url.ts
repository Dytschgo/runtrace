import { useCallback, useMemo, useSyncExternalStore } from 'react';

export const PAGES = [
  'Overview', 'Activity', 'Models', 'Projects', 'Threads', 'Agent Trees', 'Tool Calls',
  'Quota and Resets', 'Storage', 'Data Quality', 'Settings',
] as const;
export type PageName = (typeof PAGES)[number] | 'Search';

/** Parameters that survive moving between pages. Everything else belongs to one page. */
export const GLOBAL_KEYS = ['project', 'model', 'instance', 'range', 'since', 'until', 'zs', 'ze', 'track', 'rp', 'up'] as const;

export type Patch = Record<string, string | number | null | undefined>;

const EVENT = 'runtrace:navigate';
const subscribe = (cb: () => void) => {
  addEventListener('popstate', cb);
  addEventListener(EVENT, cb);
  return () => { removeEventListener('popstate', cb); removeEventListener(EVENT, cb); };
};

export function applyPatch(search: string, patch: Patch): URLSearchParams {
  const p = new URLSearchParams(search);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '') p.delete(k);
    else p.set(k, String(v));
  }
  return p;
}

/** Search string for another page, keeping only global filters. */
export function pageSearch(search: string, page: PageName, extra: Patch = {}): string {
  const cur = new URLSearchParams(search);
  const next = new URLSearchParams();
  next.set('page', page);
  for (const k of GLOBAL_KEYS) { const v = cur.get(k); if (v) next.set(k, v); }
  return `?${applyPatch(next.toString(), extra)}`;
}

export function pushSearch(search: string, replace = false) {
  const url = search || location.pathname;
  if (replace) history.replaceState({}, '', url);
  else history.pushState({}, '', url);
  dispatchEvent(new Event(EVENT));
}

export function resolvePage(params: URLSearchParams): PageName {
  const p = params.get('page');
  if (p === 'Search') return 'Search';
  return (PAGES as readonly string[]).includes(p ?? '') ? (p as PageName) : 'Overview';
}

export function useUrl() {
  const search = useSyncExternalStore(subscribe, () => location.search);
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const set = useCallback((patch: Patch, opts: { replace?: boolean } = {}) => {
    pushSearch(`?${applyPatch(location.search, patch)}`, opts.replace);
  }, []);
  const go = useCallback((page: PageName, extra: Patch = {}) => pushSearch(pageSearch(location.search, page, extra)), []);
  const hrefPage = useCallback((page: PageName, extra: Patch = {}) => pageSearch(search, page, extra), [search]);
  const hrefPatch = useCallback((patch: Patch) => `?${applyPatch(search, patch)}`, [search]);
  return { search, params, set, go, hrefPage, hrefPatch, page: resolvePage(params) };
}

/** Set when navigation should move focus to the next page heading to appear. */
export const focusRequest = { pending: false };

export const CHORDS: Record<string, PageName> = {
  o: 'Overview', a: 'Activity', m: 'Models', p: 'Projects', t: 'Threads', r: 'Agent Trees', c: 'Tool Calls',
  u: 'Quota and Resets', s: 'Storage', d: 'Data Quality', x: 'Settings',
};

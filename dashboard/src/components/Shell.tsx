import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { isTypingTarget } from '../lib/keys';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import {
  Activity, CalendarDays, CircleGauge, Cpu, Database, Filter, FolderKanban, Keyboard, LayoutDashboard, MessagesSquare,
  Network, RefreshCw, Search, Settings as SettingsIcon, ShieldCheck, Wrench, X, Folder } from 'lucide-react';
import { useFilters, useHealth, useLatestRecord, useModels, useProjects, useQuota, useThreads, useUsage } from '../lib/data';
import { QUOTA_HIGH } from '../lib/quota';
import { PAGE_SCOPE, readDate, zoomOutPatch } from '../lib/filters';
import { fmtDateTime, fmtRelative, localParts, repairText, zonedDayStart } from '../lib/format';
import { nextDay } from '../lib/timeWindow';
import { useSettings } from '../lib/settings';
import { applyPatch, CHORDS, focusRequest, pushSearch, useUrl, type PageName } from '../lib/url';
import { Logo } from './Logo';
import { TimeSlider } from './TimeSlider';
import { AppLink, Segmented, SelectField } from './ui';

const NAV: { page: PageName; icon: ReactNode; gap?: boolean }[] = [
  { page: 'Overview', icon: <LayoutDashboard size={16} /> },
  { page: 'Activity', icon: <Activity size={16} /> },
  { page: 'Models', icon: <Cpu size={16} /> },
  { page: 'Projects', icon: <FolderKanban size={16} /> },
  { page: 'Threads', icon: <MessagesSquare size={16} />, gap: true },
  { page: 'Agent Trees', icon: <Network size={16} /> },
  { page: 'Tool Calls', icon: <Wrench size={16} /> },
  { page: 'Quota and Resets', icon: <CircleGauge size={16} />, gap: true },
  { page: 'Storage', icon: <Database size={16} />, gap: true },
  { page: 'Data Quality', icon: <ShieldCheck size={16} /> },
  { page: 'Settings', icon: <SettingsIcon size={16} /> },
];

/** A quota window at or above the mark, read by the agent and not yet reset, so it is seen from any page before it refuses work. */
function useQuotaHigh() {
  const quota = useQuota('quota/current');
  return (quota.data?.data ?? []).some((r) => {
    const used = typeof r.used_percentage === 'number' ? r.used_percentage : null;
    const reset = typeof r.reset_at === 'string' ? Date.parse(r.reset_at) : NaN;
    return used !== null && used >= QUOTA_HIGH && r.reset_passed !== true && !(Number.isFinite(reset) && reset <= Date.now());
  });
}

function Nav() {
  const { page, hrefPage } = useUrl();
  const quotaHigh = useQuotaHigh();
  const row = useRef<HTMLElement>(null);
  const ink = useRef<HTMLSpanElement>(null);
  // The ink slides between pages. It is measured because the current item is wider than the rest.
  useLayoutEffect(() => {
    const place = () => {
      const cur = row.current?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!ink.current) return;
      ink.current.style.opacity = cur ? '1' : '0';
      if (cur) { ink.current.style.inlineSize = `${cur.offsetWidth}px`; ink.current.style.transform = `translateX(${cur.offsetLeft}px)`; }
      // On a phone the row scrolls sideways, so the current page is brought into view.
      const r = row.current;
      if (cur && r && r.scrollWidth > r.clientWidth) r.scrollLeft = cur.offsetLeft - (r.clientWidth - cur.offsetWidth) / 2;
    };
    place();
    if (typeof ResizeObserver !== 'function' || !row.current) return;
    const ro = new ResizeObserver(place);
    ro.observe(row.current);
    return () => ro.disconnect();
  }, [page]);
  return (
    <nav aria-label="Main navigation" className="nav" ref={row}>
      {NAV.map((it) => (
        <AppLink key={it.page} href={hrefPage(it.page)} className={it.gap ? 'nav-link nav-gap' : 'nav-link'} ariaCurrent={page === it.page ? 'page' : undefined} ariaLabel={it.page === 'Quota and Resets' && quotaHigh ? `${it.page}, a limit is nearly reached` : it.page}>
          {it.page === 'Quota and Resets' && quotaHigh && <span className="nav-alert" aria-hidden="true" />}
          <span aria-hidden="true">{it.icon}</span>
          {page === it.page ? <span className="nav-name" aria-hidden="true">{it.page}</span> : <span className="nav-tip" aria-hidden="true">{it.page}</span>}
        </AppLink>
      ))}
      <span className="nav-ink" ref={ink} aria-hidden="true" />
    </nav>
  );
}

function dateInTz(iso: string | undefined, tz: string) {
  if (!iso) return '';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : localParts(new Date(t), tz).date;
}

function FilterBar() {
  const { page, params, set } = useUrl();
  const { timezone } = useSettings();
  const filters = useFilters();
  const projects = useProjects();
  const needsLists = page !== 'Overview';
  const models = useModels({}, needsLists);
  const machines = useUsage('machines', {}, needsLists);
  const [open, setOpen] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setSlot(document.getElementById('scope-filters')), []);
  const scope = PAGE_SCOPE[page] ?? 'all';
  const custom = !filters.range && !!(filters.since || filters.until);
  const [showDates, setShowDates] = useState(false);
  const rangeValue = filters.range ?? (custom ? 'custom' : 'all');

  // The aggregate is the cheap source of instances; threads are read only when it is unavailable.
  const threads = useThreads({}, machines.isError && needsLists);
  const instances = useMemo(
    () => [...new Set(machines.data ? machines.data.map((m) => m.identity) : (threads.data?.rows ?? []).map((t) => t.instance_id))].sort(),
    [machines.data, threads.data],
  );
  const projectName = (id: string) => {
    const p = projects.data?.find((r) => r.source_id === id);
    return p ? repairText(String(p.data?.name ?? id)) : id;
  };

  const activeCount = [filters.project, filters.model, filters.instance, params.get('range') || params.get('since') || params.get('until'), params.get('pick')].filter(Boolean).length;
  // On the overview a row is the filter, so these controls only appear where a page has no rows of its own to click.
  const onOverview = page === 'Overview';
  // Clear takes away what narrows the scope and keeps the time chosen. With nothing else left, it puts the time back to the default.
  const scoped = !!(filters.project || filters.model || filters.instance || params.get('pick'));
  const clear = () => {
    setShowDates(false);
    set(scoped
      ? { project: null, model: null, instance: null, pick: null, offset: null }
      : { range: null, since: null, until: null, zs: null, ze: null, track: null, rp: null, up: null, offset: null });
  };
  const setRange = (v: string) => set({ range: v, since: null, until: null, zs: null, ze: null, track: null, rp: null, up: null, offset: null });
  // The fields show the days that were picked, even a day still in progress, which the window treats as reaching now. A link written backwards reads the right way round here too.
  const [rawSince, rawUntil] = [readDate(params.get('since')), readDate(params.get('until'))];
  const [pickedSince, pickedUntil] = rawSince && rawUntil && Date.parse(rawSince) > Date.parse(rawUntil) ? [rawUntil, rawSince] : [rawSince, rawUntil];
  const setDay = (key: 'since' | 'until', day: string) => {
    if (!day) return set({ [key]: null, ...(key === 'since' ? { until: pickedUntil ?? null } : { since: pickedSince ?? null }), offset: null });
    const start = zonedDayStart(day, timezone).toISOString();
    const end = new Date(zonedDayStart(nextDay(day), timezone).getTime() - 1).toISOString();
    // Both ends are written, so what is saved is what the fields showed. Moving one end past the other brings the other along.
    const ends = key === 'since'
      ? { since: start, until: pickedUntil ? (Date.parse(pickedUntil) < Date.parse(start) ? end : pickedUntil) : null }
      : { until: end, since: (pickedSince ?? filters.since) ? (Date.parse((pickedSince ?? filters.since)!) > Date.parse(end) ? start : (pickedSince ?? filters.since)!) : null };
    set({ ...ends, range: null, zs: null, ze: null, track: null, rp: null, offset: null });
  };

  if (scope === 'none') {
    return <div className="filterbar filterbar-note"><Filter size={14} aria-hidden="true" /> Whole database. Filters do not apply here.</div>;
  }

  return (
    <div className="filterbar" data-open={open}>
      <TimeSlider />
      <Segmented
        label="Time range" value={rangeValue} onChange={setRange}
        options={[{ value: 'all', label: 'All' }, { value: '1h', label: '1h' }, { value: '6h', label: '6h' }, { value: '24h', label: '24h' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }]}
      />
      {!onOverview && (
        <button type="button" className="btn filter-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Filter size={14} aria-hidden="true" /> Filters{activeCount ? ` (${activeCount})` : ''}
        </button>
      )}
      {slot && createPortal(
      <div className="filter-body" data-open={open || onOverview}>
        {onOverview ? <>
          {filters.project && <button type="button" className="scope-chip" onClick={() => set({ project: null, offset: null })} title="Remove this filter"><Folder size={13} aria-hidden="true" />{projectName(filters.project)}<X size={13} aria-hidden="true" /></button>}
          {filters.model && <button type="button" className="scope-chip mono" onClick={() => set({ model: null, offset: null })} title="Remove this filter">{filters.model}<X size={13} aria-hidden="true" /></button>}
          {filters.instance && <button type="button" className="scope-chip" onClick={() => set({ instance: null, offset: null })} title="Remove this filter">{filters.instance}<X size={13} aria-hidden="true" /></button>}
        </> : <>
        <button type="button" className={showDates ? 'icon-btn is-on' : 'icon-btn'} aria-expanded={showDates} aria-label="Exact dates" title="Exact dates" onClick={() => setShowDates((v) => !v)}>
          <CalendarDays size={15} aria-hidden="true" />
        </button>
        {showDates && (
          <div className="date-range">
            <label className="field"><span className="sr-only">From date</span><input type="date" aria-label="From date" value={dateInTz(filters.range ? filters.since : pickedSince, timezone)} onChange={(e) => setDay('since', e.target.value)} /></label>
            <span className="fine" aria-hidden="true">to</span>
            <label className="field"><span className="sr-only">To date</span><input type="date" aria-label="To date" value={dateInTz(pickedUntil, timezone)} onChange={(e) => setDay('until', e.target.value)} /></label>
          </div>
        )}
        <SelectField
          label="Project" hideLabel value={filters.project ?? ''} onChange={(v) => set({ project: v, offset: null })}
          options={[{ value: '', label: 'All projects' }, ...(projects.data ?? []).map((p) => ({ value: p.source_id, label: projectName(p.source_id) })),
            ...(filters.project && !projects.data?.some((p) => p.source_id === filters.project) ? [{ value: filters.project, label: filters.project }] : [])]}
        />
        <SelectField
          label="Model" hideLabel value={filters.model ?? ''} onChange={(v) => set({ model: v, offset: null })}
          disabled={scope === 'no-model'} title={scope === 'no-model' ? `${page} records carry no model, so this filter does not apply here.` : undefined}
          options={[{ value: '', label: scope === 'no-model' ? 'Model: n/a here' : 'All models' }, ...(models.data ?? []).flatMap((m) => (m.model ? [{ value: m.model, label: m.model }] : [])),
            ...(filters.model && !models.data?.some((m) => m.model === filters.model) ? [{ value: filters.model, label: filters.model }] : [])]}
        />
        {(instances.length > 1 || filters.instance) && (
          <SelectField
            label="Instance" hideLabel value={filters.instance ?? ''} onChange={(v) => set({ instance: v, offset: null })}
            options={[{ value: '', label: 'All instances' }, ...instances.map((i) => ({ value: i, label: i })), ...(filters.instance && !instances.includes(filters.instance) ? [{ value: filters.instance, label: filters.instance }] : [])]}
          />
        )}
        </>}
        {activeCount > 0 && <button type="button" className="btn btn-quiet" onClick={clear}><X size={14} aria-hidden="true" /> Clear</button>}
      </div>, slot)}
    </div>
  );
}

function Topbar({ searchRef }: { searchRef: React.RefObject<HTMLInputElement | null> }) {
  const { params, go, page, hrefPage } = useUrl();
  const { timezone } = useSettings();
  const latest = useLatestRecord();
  const health = useHealth();
  const client = useQueryClient();
  const fetching = useIsFetching();
  const quotaHigh = useQuotaHigh();
  const q = params.get('q') ?? '';
  const online = health.isSuccess;
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const value = String(new FormData(e.currentTarget).get('q') ?? '').trim();
    if (value) go('Search', { q: value });
    else if (page === 'Search') go('Overview');
  };
  return (
    <div className="topbar">
      <AppLink href={hrefPage('Overview')} className="brand" ariaLabel="Runtrace home"><Logo /></AppLink>
      <Nav />
      <div id="scope-filters" className="scope-filters" />
      <div className="topbar-right">
        {quotaHigh && page !== 'Quota and Resets' && <AppLink className="quota-alert-mini" href={hrefPage('Quota and Resets')} ariaLabel="A quota limit is nearly reached"><span aria-hidden="true" /></AppLink>}
        <span className="fresh" title={latest.data ? `Newest record ${fmtDateTime(latest.data.occurred_at, timezone)} (${timezone})` : undefined}>
          <span className={online ? 'pulse pulse-on' : 'pulse'} aria-hidden="true" />
          <span className="sr-only">{health.isPending ? 'Checking service' : online ? 'Local service online' : 'Service offline'}. </span>
          {latest.data ? <>{fmtRelative(latest.data.occurred_at)}</> : latest.isError ? 'Unknown' : ' '}
        </span>
        <form role="search" className="search" onSubmit={onSubmit} key={q}>
          <Search size={14} aria-hidden="true" />
          <input ref={searchRef} name="q" type="search" defaultValue={q} aria-label="Search captured content" placeholder="Search" maxLength={500} />
          <kbd aria-hidden="true">/</kbd>
        </form>
        <button type="button" className="icon-btn" aria-label="Refresh data" title="Refresh data" onClick={() => client.invalidateQueries()}>
          <RefreshCw size={15} aria-hidden="true" className={fetching ? 'spin' : undefined} />
        </button>
      </div>
    </div>
  );
}

function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="shortcuts-title">
      <header className="dialog-head">
        <h2 id="shortcuts-title"><Keyboard size={16} aria-hidden="true" /> Keyboard shortcuts</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close shortcuts"><X size={15} aria-hidden="true" /></button>
      </header>
      <dl className="shortcuts">
        <div><dt><kbd>/</kbd></dt><dd>Search captured content</dd></div>
        <div><dt><kbd>?</kbd></dt><dd>This list</dd></div>
        <div><dt><kbd>z</kbd></dt><dd>Zoom out one step</dd></div>
        <div><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Move a time handle one bar</dd></div>
        <div><dt><kbd>Shift</kbd> <kbd>←</kbd> <kbd>→</kbd></dt><dd>Move the whole window</dd></div>
        <div><dt><kbd>PgUp</kbd> <kbd>PgDn</kbd></dt><dd>Move a time handle a week, or a day when zoomed in</dd></div>
        <div><dt><kbd>Home</kbd> <kbd>End</kbd></dt><dd>Move a time handle to the start or end of the track</dd></div>
        <div><dt><kbd>↑</kbd> <kbd>↓</kbd></dt><dd>Move between rows in the overview list</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>Let go of a pinned chart reading</dd></div>
        <div><dt><kbd>[</kbd></dt><dd>Same length of time before</dd></div>
        <div><dt><kbd>]</kbd></dt><dd>Same length of time after</dd></div>
        {Object.entries(CHORDS).map(([k, p]) => <div key={k}><dt><kbd>g</kbd> <kbd>{k}</kbd></dt><dd>{p}</dd></div>)}
      </dl>
    </dialog>
  );
}

export { isTypingTarget };

export function Shell({ children }: { children: ReactNode }) {
  const { page, go, params } = useUrl();
  const { density } = useSettings();
  const health = useHealth();
  const searchRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [help, setHelp] = useState(false);
  const firstRender = useRef(true);
  const threadId = params.get('id');
  const prevPlace = useRef(`${page}|${threadId}`);

  useEffect(() => {
    let chord = false;
    let timer = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target) || document.querySelector('dialog[open]')) return;
      if (chord) {
        chord = false;
        window.clearTimeout(timer);
        const target = CHORDS[e.key.toLowerCase()];
        if (target) { e.preventDefault(); go(target); }
        return;
      }
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); }
      else if (e.key === '?') { e.preventDefault(); setHelp(true); }
      else if (e.key === 'g') { chord = true; timer = window.setTimeout(() => { chord = false; }, 1200); }
      // Only a page with a time window has anything to zoom out of. Search looks through everything.
      else if (e.key === 'z' && page !== 'Search' && PAGE_SCOPE[page] !== 'none' && new URLSearchParams(location.search).get('range') !== 'all') { e.preventDefault(); pushSearch(`?${applyPatch(location.search, zoomOutPatch(new URLSearchParams(location.search)))}`); }
    };
    addEventListener('keydown', onKey);
    return () => { removeEventListener('keydown', onKey); window.clearTimeout(timer); };
  }, [go, params, page]);

  // A page change moves focus to the new heading, so keyboard and screen reader users land on the content.
  useEffect(() => {
    document.title = `${page} · Runtrace`;
    if (firstRender.current) { firstRender.current = false; return; }
    const place = `${page}|${threadId}`;
    if (prevPlace.current !== place) {
      prevPlace.current = place;
      window.scrollTo({ top: 0 });
      focusRequest.pending = true;
    }
  }, [page, threadId]);

  return (
    <div className="shell" data-density={density}>
      <a className="skip-link" href="#content" onClick={(e) => { e.preventDefault(); mainRef.current?.querySelector<HTMLElement>('[data-page-title]')?.focus(); }}>Skip to content</a>
      <header className="sticky-head">
        <Topbar searchRef={searchRef} />
        <FilterBar />
      </header>
      <main className="main" ref={mainRef} id="content">
        {health.isError && (
          <div className="banner" role="alert">
            <strong>Cannot reach the local service.</strong> Showing the last data loaded in this tab. Start it with <code>t3ui serve</code>.
            <button type="button" className="link-btn" onClick={() => health.refetch()}>Check again</button>
          </div>
        )}
        <div className="page" key={page}>{children}</div>
        <footer className="foot">
          <span>Solid is measured. <span className="unknown unknown-inline">Hatched</span> is missing.</span>
          <button type="button" className="link-btn" onClick={() => setHelp(true)}>Shortcuts <kbd>?</kbd></button>
          <span>Local only</span>
        </footer>
      </main>
      <ShortcutsDialog open={help} onClose={() => setHelp(false)} />
    </div>
  );
}

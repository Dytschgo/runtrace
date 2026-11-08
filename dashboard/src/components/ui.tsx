import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { AlertTriangle, Check, CheckCircle2, ChevronRight, CircleDashed, CircleSlash, Copy, Inbox, Loader, RefreshCw, TableProperties, XCircle } from 'lucide-react';
import { ApiError } from '../lib/api';
import { fmtCompact, fmtInt, fmtPct, isKnown } from '../lib/format';
import { focusRequest, pushSearch } from '../lib/url';
import { fromQuery, type Load } from '../lib/load';
import { smoothPath } from './TraceChart';

/** A client-side link: real href for new tabs and copying, history navigation for plain clicks. */
export function AppLink({ href, className, children, title, ariaCurrent, ariaLabel, tabIndex }: {
  href: string; className?: string; children: ReactNode; title?: string; ariaCurrent?: 'page' | 'true'; ariaLabel?: string; tabIndex?: number;
}) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    pushSearch(href);
  };
  return <a href={href} className={className} onClick={onClick} title={title} aria-current={ariaCurrent} aria-label={ariaLabel} tabIndex={tabIndex}>{children}</a>;
}

export function Panel({ title, sub, action, children, className = '', flush, id }: {
  title?: ReactNode; sub?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; flush?: boolean; id?: string;
}) {
  return (
    <section className={`panel ${className}`} id={id}>
      {(title || action) && (
        <header className="panel-head">
          <div className="panel-title">
            {title && <h2>{title}</h2>}
            {sub && <p>{sub}</p>}
          </div>
          {action && <div className="panel-action">{action}</div>}
        </header>
      )}
      <div className={flush ? 'panel-body panel-body-flush' : 'panel-body'}>{children}</div>
    </section>
  );
}

/** The one mark for missing telemetry: hatched, labelled and explained, never a zero or a dash. */
export function Unknown({ label = 'Not captured', why }: { label?: string; why?: string }) {
  return (
    <span className="unknown" title={why}>
      {label}
      {why && <span className="sr-only">. {why}</span>}
    </span>
  );
}

/** A number whose request failed. It is not known, which is never the same as zero. */
export function NotLoaded() {
  return <Unknown label="Not loaded" why="The request for this failed, so it is not known. Use Retry." />;
}

/** A token count: compact to read, exact on hover. A null is shown as a gap, never zero. */
export function Tokens({ v, why = 'This token field was not recorded.' }: { v: number | null | undefined; why?: string }) {
  return isKnown(v) ? <span title={`${fmtInt(v)} tokens`}>{fmtCompact(v)}</span> : <Unknown why={why} />;
}

export function Val({ v, format = fmtInt, why }: { v: unknown; format?: (n: number) => string; why?: string }) {
  return isKnown(v) ? <>{format(v)}</> : <Unknown why={why} />;
}

export function Skeleton({ height = '12rem', label = 'Loading' }: { height?: string; label?: string }) {
  return <div className="skeleton" style={{ blockSize: height }} role="status" aria-label={label} />;
}

export function SkeletonRows({ rows = 6, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div className="skeleton-rows" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton skeleton-row" />)}
    </div>
  );
}

export function EmptyState({ icon, title, children, compact }: { icon?: ReactNode; title: string; children?: ReactNode; compact?: boolean }) {
  return (
    <div className={compact ? 'state state-compact' : 'state'}>
      <span className="state-icon" aria-hidden="true">{icon ?? <Inbox size={20} />}</span>
      <h2>{title}</h2>
      {children && <div className="state-body">{children}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const kind = error instanceof ApiError ? error.kind : 'server';
  const message = error instanceof Error ? error.message : 'Something went wrong while loading this view.';
  return (
    <div className={compact ? 'state state-compact state-error' : 'state state-error'} role="alert">
      <span className="state-icon" aria-hidden="true"><AlertTriangle size={20} /></span>
      <h2>{kind === 'offline' ? 'Analytics service unreachable' : kind === 'invalid' ? 'Query rejected' : 'Could not load this view'}</h2>
      <div className="state-body">
        <p>{message}</p>
        {kind === 'offline' && <p>Start it with <code>runtrace start</code>, then retry.</p>}
      </div>
      {onRetry && <button type="button" className="btn" onClick={onRetry}><RefreshCw size={14} aria-hidden="true" /> Retry</button>}
    </div>
  );
}

/** Loading, failure and empty handling for one query or one Load, so a failed panel never takes the page down.
 *  Data that already loaded stays shown when a later refresh fails, with a note and a retry, instead of vanishing. */
export function Async<T>({ query, children, skeleton, isEmpty, empty, compact }: {
  query: UseQueryResult<T> | Load<T>; children: (data: T) => ReactNode; skeleton?: ReactNode; isEmpty?: (data: T) => boolean; empty?: ReactNode; compact?: boolean;
}) {
  const load = 'state' in query ? query : fromQuery(query);
  if (load.state === 'loading') return <>{skeleton ?? <Skeleton />}</>;
  if (load.state === 'failed') return <ErrorState error={load.error} onRetry={load.retry} compact={compact} />;
  const body = isEmpty?.(load.data) ? <>{empty ?? <NoRecords compact={compact} />}</> : <>{children(load.data)}</>;
  if (!load.stale) return body;
  return (
    <>
      {body}
      <p className="stale-note" role="status">
        Could not refresh, so this is what loaded earlier. <button type="button" className="link-btn" onClick={load.stale.retry}>Retry</button>
      </p>
    </>
  );
}

/** One figure: "…" while loading, "Not loaded" when its read failed, the value once ready. Never a 0 that was not measured. */
export function StatValue<T>({ load, children }: { load: Load<T>; children: (data: T) => ReactNode }) {
  if (load.state === 'loading') return <span role="status" aria-label="Loading">…</span>;
  if (load.state === 'failed') return <NotLoaded />;
  return <>{children(load.data)}</>;
}

export function NoRecords({ compact }: { compact?: boolean }) {
  return (
    <EmptyState title="No records match" compact={compact}>
      <p>Widen the time range or clear filters. An empty result means nothing was imported here, not that nothing happened.</p>
    </EmptyState>
  );
}

const STATUS: Record<string, { label: string; tone: string; icon: ReactNode }> = {
  completed: { label: 'Completed', tone: 'good', icon: <CheckCircle2 size={13} /> },
  failed: { label: 'Failed', tone: 'crit', icon: <XCircle size={13} /> },
  cancelled: { label: 'Cancelled', tone: 'warn', icon: <CircleSlash size={13} /> },
  running: { label: 'Running', tone: 'accent', icon: <Loader size={13} /> },
  queued: { label: 'Queued', tone: 'neutral', icon: <CircleDashed size={13} /> },
  interrupted: { label: 'Interrupted', tone: 'warn', icon: <CircleSlash size={13} /> },
};

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <Unknown label="Unknown" why="The source did not record a status." />;
  const s = STATUS[status];
  return <span className={`status status-${s?.tone ?? 'neutral'}`}><span aria-hidden="true">{s?.icon ?? <CircleDashed size={13} />}</span>{s?.label ?? status}</span>;
}

const QUALITY_WHY: Record<string, string> = {
  complete: 'Every expected field for this record was captured.',
  partial: 'Some fields for this record are not available from the source.',
  inferred: 'Derived from other records rather than observed.',
  unavailable: 'The source offers no data for this.',
};
export function QualityBadge({ quality }: { quality: string | null | undefined }) {
  const q = quality ?? 'unavailable';
  return <span className={`quality quality-${q}`} title={QUALITY_WHY[q]}>{q}</span>;
}

export function Tag({ children, tone }: { children: ReactNode; tone?: 'accent' | 'warn' | 'crit' }) {
  return <span className={`tag${tone ? ` tag-${tone}` : ''}`}>{children}</span>;
}

export interface RankedItem { key: string; label: ReactNode; value: number; href?: string; display?: ReactNode; swatch?: string; note?: ReactNode; active?: boolean }

/** A ranked list in HTML rather than an SVG chart: long labels wrap, rows can link, and it reads as text. */
export function RankedBars({ items, total, label, limit }: { items: RankedItem[]; total?: number; label: string; limit?: number }) {
  const shown = limit ? items.slice(0, limit) : items;
  const max = Math.max(1, ...items.map((i) => i.value));
  const hidden = items.length - shown.length;
  return (
    <>
      <ol className="ranked" aria-label={label}>
        {shown.map((it) => (
          <li key={it.key} className={it.active ? 'ranked-row is-active' : 'ranked-row'}>
            <div className="ranked-meta">
              {it.swatch && <span className="swatch" style={{ background: it.swatch }} aria-hidden="true" />}
              <span className="ranked-label">{it.href ? <AppLink href={it.href}>{it.label}</AppLink> : it.label}</span>
              <span className="ranked-value">
                {it.display ?? fmtInt(it.value)}
                {total ? <small>{fmtPct(it.value / total)}</small> : null}
              </span>
            </div>
            <div className="ranked-track" aria-hidden="true"><span style={{ inlineSize: `${(it.value / max) * 100}%`, background: it.swatch }} /></div>
            {it.note && <div className="ranked-note">{it.note}</div>}
          </li>
        ))}
      </ol>
      {hidden > 0 && <p className="fine">{fmtInt(hidden)} more not shown</p>}
    </>
  );
}

/** Solid is measured, hatched is missing. The same split as every other gap in the product. */
export function CoverageBar({ known, total, label }: { known: number; total: number; label: string }) {
  const ratio = total ? known / total : 0;
  return (
    <div className="coverage" role="img" aria-label={`${label}: ${fmtInt(known)} of ${fmtInt(total)} known`}>
      <span className="coverage-known" style={{ inlineSize: `${ratio * 100}%` }} />
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'crit' | 'warn' | 'good' }) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ''}`}>
      <dt>{label}</dt>
      <dd>
        <span className="stat-value">{value}</span>
        {sub && <small>{sub}</small>}
      </dd>
    </div>
  );
}

export function StatRow({ children, label }: { children: ReactNode; label?: string }) {
  return <dl className="stat-row" aria-label={label}>{children}</dl>;
}

/** A thread or series as a small trace that draws itself. Colour comes from the surrounding text colour. */
export function Sparkline({ values, label }: { values: number[]; label?: string }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const d = smoothPath(values.map((v, i) => [(i / (values.length - 1)) * 104, 21 - (v / max) * 19]));
  return (
    <svg className="sparkline" viewBox="0 0 104 22" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d={d} pathLength={1} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch { /* the command stays selectable when the clipboard is blocked */ }
  };
  return (
    <div className="command">
      <code>{text}</code>
      <button type="button" className="icon-btn" onClick={copy} aria-label={copied ? `Copied ${text}` : `Copy ${text}`}>
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
    </div>
  );
}

export function Segmented<T extends string>({ label, value, options, onChange, hideLabel = true }: {
  label: string; value: T; options: { value: T; label: ReactNode; title?: string; disabled?: boolean }[]; onChange: (v: T) => void; hideLabel?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className="segmented">
      <legend className={hideLabel ? 'sr-only' : 'field-label'}>{label}</legend>
      <div className="segmented-track">
        {options.map((o) => (
          <label key={o.value} title={o.title} data-disabled={o.disabled ? 'true' : undefined}>
            <input type="radio" name={name} value={o.value} checked={o.value === value} disabled={o.disabled && o.value !== value} onChange={() => onChange(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function SelectField({ label, value, onChange, options, disabled, title, hideLabel }: {
  label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; disabled?: boolean; title?: string; hideLabel?: boolean;
}) {
  return (
    <label className="field" title={title}>
      <span className={hideLabel ? 'sr-only' : 'field-label'}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

/** Lets any chart switch to the same numbers as a table, for screen readers and for reading exact values. */
export function ChartPanel({ title, sub, chart, table, className, action }: {
  title: ReactNode; sub?: ReactNode; chart: ReactNode; table: ReactNode; className?: string; action?: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <Panel
      title={title}
      sub={sub}
      className={className}
      action={
        <>
          {action}
          <button type="button" className={showTable ? 'icon-btn is-on' : 'icon-btn'} aria-pressed={showTable} onClick={() => setShowTable((s) => !s)} aria-label="Show as table" title="Show as table">
            <TableProperties size={15} aria-hidden="true" />
          </button>
        </>
      }
    >
      {showTable ? <div className="table-scroll table-mini" tabIndex={0} role="region" aria-label="Chart data">{table}</div> : chart}
    </Panel>
  );
}

export function PageHeader({ title, lead, action, quiet }: { title: string; lead?: ReactNode; action?: ReactNode; quiet?: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Pages load lazily, so a heading claims the focus that navigation asked for once it exists.
  // The title is a dependency because a thread's page keeps its header and only changes the title.
  useEffect(() => {
    if (!focusRequest.pending) return;
    focusRequest.pending = false;
    heading.current?.focus({ preventScroll: true });
  }, [title]);
  return (
    <div className={quiet ? 'page-head page-head-quiet' : 'page-head'}>
      <div>
        <h1 ref={heading} tabIndex={-1} data-page-title className={quiet ? 'sr-only' : undefined}>{title}</h1>
        {lead && <p>{lead}</p>}
      </div>
      {action && <div className="page-head-action">{action}</div>}
    </div>
  );
}

/** Whether a list covers everything: complete, a sample, reading the rest, or a failed attempt to read the rest. */
export function ScanNote({ scanned, complete, noun, total, onExpand, reading, progress, failed, onRetry }: { scanned: number; complete: boolean; noun: string; total?: number; onExpand?: () => void; reading?: boolean; progress?: number; failed?: boolean; onRetry?: () => void }) {
  if (complete) return <span className="fine">All {fmtInt(scanned)} {noun} read</span>;
  return (
    <span className="scan-note" role="status">
      {reading ? <Loader size={13} aria-hidden="true" className="spin" /> : <AlertTriangle size={13} aria-hidden="true" />}
      <span>Latest {fmtInt(scanned)}{isKnown(total) ? ` of ${fmtInt(total)}` : ''} {noun}.{reading ? ` Reading the rest${progress ? ` (${fmtInt(progress)})` : ''}…` : failed ? ' Could not read the rest.' : ''}</span>
      {failed && onRetry && !reading ? <button type="button" className="link-btn" onClick={onRetry}>Retry</button>
        : onExpand && !reading && <button type="button" className="link-btn" onClick={onExpand}>Analyze all</button>}
    </span>
  );
}

export const plural = (n: number, one: string, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;

/** A panel that stays closed until asked, so long supporting tables do not push the main content down. */
export function DisclosurePanel({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="panel disclosure" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <span className="panel-title"><h2>{title}</h2>{sub && <p>{sub}</p>}</span>
        <ChevronRight size={15} aria-hidden="true" className="disclosure-caret" />
      </summary>
      {open && <div className="panel-body panel-body-flush">{children}</div>}
    </details>
  );
}

/** The whole page for a window that has not happened yet. Nothing is shown as zero. */
export function NotYetPage({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} />
      <Panel><EmptyState title="Not yet"><p>This window starts later than now, so nothing is known about it yet.</p></EmptyState></Panel>
    </>
  );
}

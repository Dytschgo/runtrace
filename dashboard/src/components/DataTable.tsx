import { useMemo, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Download } from 'lucide-react';
import { toCsv } from '../lib/api';
import { fmtInt } from '../lib/format';
import { useSettings } from '../lib/settings';
import { useUrl } from '../lib/url';

export interface Column<R> {
  key: string;
  header: string;
  render: (r: R) => ReactNode;
  /** Present when the column can be sorted. Null values always sort last. */
  sort?: (r: R) => string | number | null;
  csv?: (r: R) => string | number | null;
  align?: 'end';
  className?: string;
}

const LIMITS = [25, 50, 100];

export function sortRows<R>(rows: R[], col: Column<R> | undefined, dir: 'asc' | 'desc'): R[] {
  if (!col?.sort) return rows;
  const get = col.sort;
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * sign;
  });
}

export function downloadCsv(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Sort and page live in the URL under an optional prefix, so a view can be shared and survives reload. */
export function DataTable<R>({ rows, columns, rowKey, caption, defaultSort, paged = true, prefix = '', exportName, stickyFirst = true, empty, defaultLimit }: {
  rows: R[]; columns: Column<R>[]; rowKey: (r: R) => string; caption: string; defaultSort?: { key: string; dir: 'asc' | 'desc' };
  paged?: boolean; prefix?: string; exportName?: string; stickyFirst?: boolean; empty?: ReactNode; defaultLimit?: number;
}) {
  const { params, set } = useUrl();
  const { pageSize } = useSettings();
  const sortKey = params.get(`${prefix}sort`) ?? defaultSort?.key;
  const dir = (params.get(`${prefix}dir`) ?? defaultSort?.dir ?? 'desc') as 'asc' | 'desc';
  const limit = Math.min(500, Number(params.get(`${prefix}limit`)) || defaultLimit || pageSize);
  const rawOffset = Math.max(0, Number(params.get(`${prefix}offset`)) || 0);
  const col = columns.find((c) => c.key === sortKey);
  const sorted = useMemo(() => sortRows(rows, col, dir), [rows, col, dir]);
  const offset = rawOffset < sorted.length ? rawOffset : 0;
  const visible = paged ? sorted.slice(offset, offset + limit) : sorted;
  const showPager = paged && rows.length > Math.min(limit, LIMITS[0]);

  const toggle = (c: Column<R>) => {
    const nextDir = sortKey === c.key && dir === 'desc' ? 'asc' : 'desc';
    set({ [`${prefix}sort`]: c.key, [`${prefix}dir`]: nextDir, [`${prefix}offset`]: null }, { replace: true });
  };
  const exportCsv = () => {
    const cols = columns.filter((c) => c.csv || c.sort);
    downloadCsv(`${exportName}.csv`, toCsv(cols.map((c) => c.header), sorted.map((r) => cols.map((c) => (c.csv ?? c.sort)!(r)))));
  };

  if (!rows.length && empty) return <>{empty}</>;
  return (
    <div className="data-table">
      <div className="table-scroll" tabIndex={0} role="region" aria-label={caption}>
        <table className={stickyFirst ? 'sticky-first' : undefined}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sortKey === c.key;
                return (
                  <th key={c.key} scope="col" className={`${c.align === 'end' ? 'num' : ''} ${c.className ?? ''}`} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    {c.sort ? (
                      <button type="button" className="th-sort" onClick={() => toggle(c)}>
                        {c.header}
                        <span aria-hidden="true">{active ? (dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <ChevronsUpDown size={12} className="th-idle" />}</span>
                      </button>
                    ) : c.header}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={rowKey(r)}>
                {columns.map((c) => <td key={c.key} className={`${c.align === 'end' ? 'num' : ''} ${c.className ?? ''}`}>{c.render(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(showPager || exportName) && (
        <div className="table-foot">
          {showPager ? (
            <Pager
              offset={offset} limit={limit} shown={visible.length} total={rows.length} label={`Pagination for ${caption}`}
              onLimit={(n) => set({ [`${prefix}limit`]: n, [`${prefix}offset`]: null })}
              onPage={(o) => set({ [`${prefix}offset`]: o || null })}
            />
          ) : <span />}
          {exportName && (
            <button type="button" className="btn btn-quiet" onClick={exportCsv}><Download size={14} aria-hidden="true" /> CSV</button>
          )}
        </div>
      )}
    </div>
  );
}

export function Pager({ offset, limit, shown, total, hasMore, onLimit, onPage, label = 'Pagination' }: {
  offset: number; limit: number; shown: number; total?: number; hasMore?: boolean; onLimit?: (n: number) => void; onPage: (offset: number) => void; label?: string;
}) {
  const more = total !== undefined ? offset + limit < total : !!hasMore;
  return (
    <nav className="pager" aria-label={label}>
      <span className="pager-range" aria-live="polite">
        {shown ? `${fmtInt(offset + 1)}–${fmtInt(offset + shown)}` : '0'}{total !== undefined ? ` of ${fmtInt(total)}` : ''}
      </span>
      <button type="button" className="icon-btn" disabled={offset <= 0} onClick={() => onPage(Math.max(0, offset - limit))} aria-label="Previous page"><ChevronLeft size={15} aria-hidden="true" /></button>
      <button type="button" className="icon-btn" disabled={!more} onClick={() => onPage(offset + limit)} aria-label="Next page"><ChevronRight size={15} aria-hidden="true" /></button>
      {onLimit && (
        <label className="pager-size">
          <span className="sr-only">Rows per page</span>
          <select value={limit} onChange={(e) => onLimit(Number(e.target.value))}>
            {[...new Set([...LIMITS, limit])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n} rows</option>)}
          </select>
        </label>
      )}
    </nav>
  );
}

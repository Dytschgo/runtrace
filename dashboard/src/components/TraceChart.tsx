import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fmtCompact, fmtInt } from '../lib/format';
import type { GroupInfo, TraceRow } from '../lib/series';
import { prefersStill } from './motion';

const M = { l: 44, r: 10, t: 12, b: 24 };
const GHOST = '__previous';
const TOTAL = '__total';

/** Curves that bend only between two points, so a line never swings above a real value. */
export function smoothPath(points: [number, number][]) {
  let d = '';
  points.forEach(([x, y], i) => {
    if (!i) { d = `M${x.toFixed(1)} ${y.toFixed(1)}`; return; }
    const [px, py] = points[i - 1];
    const mx = ((px + x) / 2).toFixed(1);
    d += `C${mx} ${py.toFixed(1)} ${mx} ${y.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  return d;
}

export function niceMax(max: number, whole = false) {
  if (max <= 0) return 4;
  if (whole && max <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(max / 4));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((k) => k * pow).find((k) => k * 4 >= max && (!whole || Number.isInteger(k))) ?? pow * 10;
  return step * 4;
}

export interface TraceChartProps {
  rows: TraceRow[]; series: GroupInfo[]; focus?: string | null; replay?: string; height?: number;
  stacked?: boolean; ghost?: (number | null)[] | null; ghostSilent?: Set<number>; ghostLower?: Set<number>; scaleTop?: number; windowStart?: number; windowEnd?: number; blackout?: Set<number>; ghostLabel?: string; unit?: string; onZoom?: (from: number, to: number) => void;
  /** A group that ran here but is not drawn, so the reading still adds up to everything that ran. */
  aside?: { label: string; values: (number | null)[]; lower?: Set<number> } | null;
  /** Lines that ran at a row but reported nothing there, so they break instead of reading as zero. */
  missingAt?: Map<number, Set<string>>;
  /** Lines at a row where only some turns reported, so the value is a lower bound. */
  partialAt?: Map<number, Set<string>>;
  /** Rows where something ran but reported nothing for this measure, with the names of what ran. */
  gaps?: Map<number, string[]>;
  /** The sum of every group, drawn when comparing lines, because the dashed line is a total too. */
  totalLine?: (number | null)[] | null;
  /** Counts have no fractions, so their axis steps stay whole. */
  whole?: boolean;
}

/** One line per group on a shared axis: the page's signature. It rises from the left once, and whenever a new view is chosen. Drag across it to zoom in. */
export function TraceChart({ rows, series, focus, replay, height: tall = 400, stacked, ghost, ghostSilent, ghostLower, scaleTop = 0, windowStart, windowEnd, blackout, ghostLabel, unit = 'tokens', onZoom, aside, gaps, totalLine, whole, missingAt, partialAt }: TraceChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/:/g, '');
  const [width, setWidth] = useState(0);
  const [pointer, setPointer] = useState<number | null>(null);
  // A click pins the reading, so it can be read at leisure and a period opened from it. Nothing changes the window by accident.
  const [pinnedAt, setPinned] = useState<number | null>(null);
  // A tap on a pinned reading lets go, but only when the press began on it. The click that follows the tap which pinned it lands there too.
  const tipPress = useRef(false);
  const [band, setBand] = useState<{ from: number; to: number } | null>(null);
  const press = useRef<{ i: number; x: number; moved: boolean } | null>(null);
  const lines = useRef(new Map<string, SVGPathElement>());
  const areas = useRef(new Map<string, SVGPathElement>());
  const holes = useRef(new Map<string, SVGPathElement>());

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const height = width > 0 && width < 640 ? Math.min(tall, 280) : tall;
  const n = rows.length;
  const pinned = pinnedAt !== null && pinnedAt < n ? pinnedAt : null;
  const hover = pinned ?? pointer;
  const max = useMemo(() => {
    const tops = rows.map((r) => (stacked ? series.reduce((s, x) => s + Number(r[x.key] ?? 0), 0) : Math.max(0, ...series.map((x) => Number(r[x.key] ?? 0)))));
    return niceMax(Math.max(scaleTop, ...tops, ...(ghost ?? []).map((v) => v ?? 0), ...(totalLine ?? []).map((v) => v ?? 0)), whole);
  }, [rows, series, stacked, ghost, totalLine, whole, scaleTop]);
  const iw = Math.max(1, width - M.l - M.r);
  const ih = Math.max(1, height - M.t - M.b);
  // A single bucket has no slope to draw, so it spans the plot as one level.
  const x = (i: number) => M.l + (n > 1 ? (iw * i) / (n - 1) : iw * i);
  const y = (v: number) => M.t + ih * (1 - v / max);

  /** Consecutive runs of points, so a value that was not reported is a break in the line and never a dive to zero. */
  const runs = (pts: [number, number][], missing: (i: number) => boolean) => {
    const out: [number, number][][] = [];
    let cur: [number, number][] = [];
    pts.forEach((p, i) => {
      if (missing(i)) { if (cur.length) out.push(cur); cur = []; } else cur.push(p);
    });
    if (cur.length) out.push(cur);
    return out;
  };
  const pathOf = (run: [number, number][]) => (run.length === 1 ? `M${run[0][0].toFixed(1)} ${run[0][1].toFixed(1)}h0.01` : smoothPath(run));

  const paint = (progress: number) => {
    const source = n > 1 ? rows : [rows[0], rows[0]];
    const under = source.map(() => 0);
    series.forEach((s, si) => {
      const tops = source.map((r, i, arr) => {
        const local = Math.min(1, Math.max(0, progress * 1.7 - (i / Math.max(1, arr.length - 1)) * 0.7 - si * 0.02));
        const eased = 1 + 2.1 * (local - 1) ** 3 + 1.1 * (local - 1) ** 2;
        return Math.max(0, Number(r?.[s.key] ?? 0) * eased);
      });
      const pts: [number, number][] = tops.map((v, i) => [x(i), y(Math.min(max * 1.03, v + (stacked ? under[i] : 0)))]);
      if (stacked) {
        const floor: [number, number][] = under.map((v, i) => [x(i), y(v)]);
        const missing = (i: number) => n > 1 && !!missingAt?.get(i)?.has(s.key);
        const topRuns = runs(pts, missing);
        const floorRuns = runs(floor, missing);
        lines.current.get(s.key)?.setAttribute('d', topRuns.map(pathOf).join(''));
        holes.current.get(s.key)?.setAttribute('d', pts.slice(0, -1).map((p, i) => (missing(i) || missing(i + 1) ? `${smoothPath([p, pts[i + 1]])}L${floor[i + 1][0].toFixed(1)} ${floor[i + 1][1].toFixed(1)}${smoothPath([floor[i + 1], floor[i]]).replace(/^M[^C]*/, '')}Z` : '')).join(''));
        areas.current.get(s.key)?.setAttribute('d', topRuns.map((top, r) => (top.length < 2 ? '' : `${smoothPath(top)}L${floorRuns[r][floorRuns[r].length - 1][0].toFixed(1)} ${floorRuns[r][floorRuns[r].length - 1][1].toFixed(1)}${smoothPath([...floorRuns[r]].reverse()).replace(/^M[^C]*/, '')}Z`)).join(''));
        tops.forEach((v, i) => { under[i] += v; });
        return;
      }
      const parts = runs(pts, (i) => n > 1 && !!missingAt?.get(i)?.has(s.key));
      holes.current.get(s.key)?.setAttribute('d', '');
      lines.current.get(s.key)?.setAttribute('d', parts.map(pathOf).join(''));
      areas.current.get(s.key)?.setAttribute('d', parts.filter((p) => p.length > 1).map((p) => `${smoothPath(p)}L${p[p.length - 1][0].toFixed(1)} ${y(0).toFixed(1)}L${p[0][0].toFixed(1)} ${y(0).toFixed(1)}Z`).join(''));
    });
    const dashed = (key: string, values: (number | null)[] | null | undefined) => {
      if (!values?.length) return;
      const list = n > 1 ? values : [values[0], values[0]];
      const parts = runs(list.map((v, i) => [x(i), y(v ?? 0)] as [number, number]), (i) => list[i] === null);
      lines.current.get(key)?.setAttribute('d', parts.map(pathOf).join(''));
    };
    dashed(GHOST, ghost);
    dashed(TOTAL, totalLine);
  };

  // Follows every change at rest, so dragging a window stays exact and instant.
  // The entrance runs across many renders, so each frame reads the latest paint and never redraws what has since changed.
  const latestPaint = useRef(paint);
  useLayoutEffect(() => { latestPaint.current = paint; if (width && n) paint(1); });

  const seen = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!width || !n || seen.current === replay) return;
    seen.current = replay;
    if (prefersStill()) return;
    let raf = 0;
    let t0 = 0;
    const step = (now: number) => {
      t0 ||= now;
      const p = Math.min(1, (now - t0) / 1300);
      latestPaint.current(p);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); latestPaint.current(1); };
  }, [replay, width, n]); // eslint-disable-line react-hooks/exhaustive-deps

  const ordered = stacked ? series : [...series].reverse();
  const at = hover !== null && hover < n ? rows[hover] : null;
  const tipRows = at ? series.map((s) => ({ s, v: Number(at[s.key] ?? 0) })).filter((r) => r.v > 0).sort((p, q) => q.v - p.v) : [];
  const asideValue = at && aside ? aside.values[hover!] ?? 0 : 0;
  const bucketTotal = tipRows.reduce((t, r) => t + r.v, 0) + asideValue;
  const cx = hover !== null ? x(hover) : 0;

  const indexAt = (clientX: number) => {
    const px = clientX - box.current!.getBoundingClientRect().left;
    return Math.max(0, Math.min(n - 1, Math.round(((px - M.l) / iw) * (n - 1))));
  };
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // A tap pins the reading at that point, with a button to open its period. Dragging to zoom is for a mouse.
    if (n && e.pointerType === 'touch') {
      // A second tap on the same point lets go, like a second click.
      const i = indexAt(e.clientX);
      const release = pinned === i;
      setPinned(release ? null : i);
      setPointer(release ? null : i);
      return;
    }
    if (!n || e.button !== 0) return;
    const i = indexAt(e.clientX);
    press.current = { i, x: e.clientX, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!n || !box.current) return;
    const i = indexAt(e.clientX);
    setPointer(i);
    const p = press.current;
    if (!p) return;
    if (Math.abs(e.clientX - p.x) > 5) p.moved = true;
    if (p.moved && onZoom) setBand({ from: Math.min(p.i, i), to: Math.max(p.i, i) });
  };
  const onUp = () => {
    const p = press.current;
    press.current = null;
    const chosen = band;
    setBand(null);
    if (!p) return;
    // A drag opens the stretch it covers. A plain click pins the reading there, and a second click on it lets go.
    if (p.moved && chosen && chosen.to > chosen.from) { setPinned(null); onZoom?.(rows[chosen.from].t, rows[chosen.to].end); }
    else if (!p.moved) setPinned((cur) => (cur === p.i ? null : p.i));
  };

  // A tap reads a point, and a tap anywhere else puts it away.
  const showing = hover !== null;
  useEffect(() => {
    if (!showing) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) { setPointer(null); setPinned(null); } };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setPinned(null); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', escape); };
  }, [showing]);

  // At most six evenly spaced labels, always including both ends.
  const ticks = useMemo(() => {
    if (n <= 1) return n ? [0] : [];
    const want = Math.min(n, Math.max(2, Math.min(6, Math.floor(iw / 130))));
    const step = (n - 1) / (want - 1);
    return [...new Set(Array.from({ length: want }, (_, i) => Math.round(i * step)))];
  }, [n, iw]);

  return (
    <div
      className="trace" ref={box} style={{ blockSize: height }} data-focus={focus ? 'true' : undefined} data-zoomable={onZoom ? 'true' : undefined}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { press.current = null; setBand(null); }} onPointerLeave={(e) => { if (e.pointerType !== 'touch') setPointer(null); }}
    >
      {width > 0 && n > 0 && (
        <svg width={width} height={height} role="img" aria-label={`${unit} over time, ${series.length} lines, ${n} points. Use the table view for exact values.`}>
          <defs>
            <pattern id={`${uid}gap`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(135)"><rect width="1.5" height="4" fill="var(--ink-2)" /></pattern>
            {series.map((s, i) => (
              <linearGradient key={s.key} id={`${uid}g${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={s.color} stopOpacity={stacked ? 0.62 : 0.24} />
                <stop offset="1" stopColor={s.color} stopOpacity={stacked ? 0.5 : 0} />
              </linearGradient>
            ))}
          </defs>
          {[0, 1, 2, 3, 4].map((k) => (
            <g key={k}>
              <line className="trace-grid" x1={M.l} x2={width - M.r} y1={y((max * k) / 4)} y2={y((max * k) / 4)} />
              <text className="trace-tick" x={M.l - 10} y={y((max * k) / 4) + 4} textAnchor="end">{k ? fmtCompact((max * k) / 4) : '0'}</text>
            </g>
          ))}
          {ticks.map((i, k) => (
            <text key={i} className="trace-tick" x={x(i)} y={height - 6} textAnchor={k === 0 ? 'start' : k === ticks.length - 1 ? 'end' : 'middle'}>{rows[i].tick}</text>
          ))}
          {n > 1 && [...(blackout ?? [])].map((i) => <rect key={i} className="trace-blackout" fill={`url(#${uid}gap)`} x={x(Math.max(0, i - 0.5))} y={M.t} width={x(Math.min(n - 1, i + 0.5)) - x(Math.max(0, i - 0.5))} height={ih}><title>Nothing was captured here</title></rect>)}
          {n > 1 && (windowStart !== undefined && rows[0].t < windowStart) && <rect className="trace-part" fill={`url(#${uid}gap)`} x={x(0)} y={M.t} width={x(1) - x(0)} height={ih}><title>This bucket is only partly in the window</title></rect>}
          {n > 1 && (rows[n - 1].end > Date.now() || (windowEnd !== undefined && rows[n - 1].end > windowEnd + 1)) && <rect className="trace-part" fill={`url(#${uid}gap)`} x={x(n - 2)} y={M.t} width={x(n - 1) - x(n - 2)} height={ih}><title>This bucket is not complete yet</title></rect>}
          {ghost?.length ? <path ref={(el) => { if (el) lines.current.set(GHOST, el); else lines.current.delete(GHOST); }} className="trace-ghost" /> : null}
          {totalLine?.length ? <path ref={(el) => { if (el) lines.current.set(TOTAL, el); else lines.current.delete(TOTAL); }} className="trace-total" /> : null}
          {hover !== null && <line className="trace-cross" x1={cx} x2={cx} y1={M.t} y2={M.t + ih} />}
          {ordered.map((s) => {
            const i = series.indexOf(s);
            const on = !focus || focus === s.key;
            return (
              <g key={s.key} className="trace-series" data-on={on ? 'true' : 'false'}>
                <path ref={(el) => { if (el) areas.current.set(s.key, el); else areas.current.delete(s.key); }} className="trace-area" fill={`url(#${uid}g${i})`} />
                <path ref={(el) => { if (el) holes.current.set(s.key, el); else holes.current.delete(s.key); }} className="trace-hole" fill={`url(#${uid}gap)`} />
                <path ref={(el) => { if (el) lines.current.set(s.key, el); else lines.current.delete(s.key); }} className="trace-line" stroke={s.color} strokeDasharray={s.key === 'Other' ? '1 4' : s.dashArray ?? (s.dash ? '3 3' : undefined)} />
              </g>
            );
          })}
          {at && !stacked && tipRows.map(({ s, v }) => <circle key={s.key} cx={cx} cy={y(v)} r={3.5} fill={s.color} stroke="var(--bg)" strokeWidth={2} />)}
          {gaps && [...gaps.keys()].map((i) => <rect key={i} className="trace-gap" fill={`url(#${uid}gap)`} x={x(i) - 4} y={y(0) - 7} width={8} height={7}><title>{`${rows[i]?.label}: ${gaps.get(i)!.join(', ')} ran but reported no ${unit}`}</title></rect>)}
          {band && <rect className="trace-band" x={x(band.from)} y={M.t} width={Math.max(1, x(band.to) - x(band.from))} height={ih} />}
        </svg>
      )}
      {(ghost?.length || totalLine?.length) ? (
        <p className="trace-key" aria-hidden="true">
          {totalLine?.length ? <span><i className="trace-key-total" />Total</span> : null}
          {ghost?.length ? <span><i className="trace-key-ghost" />{ghostLabel ?? 'Previous'}</span> : null}
        </p>
      ) : null}
      {at && !band && (
        <div className={pinned !== null ? 'trace-tip trace-tip-pinned' : 'trace-tip'} onPointerDown={(e) => { e.stopPropagation(); tipPress.current = true; }} onPointerUp={(e) => e.stopPropagation()} onClick={(e) => { const own = tipPress.current; tipPress.current = false; if (own && !(e.target as HTMLElement).closest('button')) { setPinned(null); setPointer(null); } }} style={width < 520 ? { insetInline: 4, minInlineSize: 0, insetBlockStart: 'calc(100% + 6px)' } : cx + 216 > width ? { insetInlineEnd: width - cx + 14 } : { insetInlineStart: cx + 14 }}>
          <div className="trace-tip-head"><b>{blackout?.has(hover!) ? 'Not captured' : tipRows.length || asideValue || !gaps?.get(hover!)?.length ? `${partialAt?.get(hover!)?.size || gaps?.get(hover!)?.length || aside?.lower?.has(hover!) ? '≥ ' : ''}${fmtCompact(bucketTotal)}` : 'Not reported'}</b><span>{at.label}{at.end > Date.now() ? ' · so far' : (windowStart !== undefined && at.t < windowStart) || (windowEnd !== undefined && at.end > windowEnd + 1) ? ' · part' : ''}</span></div>
          {tipRows.length ? tipRows.map(({ s, v }) => (
            <div key={s.key} className="trace-tip-row" title={`${fmtInt(v)} ${unit}`}><i style={{ background: s.dashArray ? `repeating-linear-gradient(90deg, ${s.color} 0 3px, transparent 3px 5px)` : s.color }} /><span>{s.label}</span><b>{partialAt?.get(hover!)?.has(s.key) ? '≥ ' : ''}{fmtCompact(v)}</b></div>
          )) : gaps?.get(hover!)?.length || asideValue ? null : <div className="trace-tip-row"><span>{blackout?.has(hover!) ? 'No records from this time' : at.end > Date.now() ? 'Nothing yet' : 'Nothing ran'}</span></div>}
          {asideValue > 0 && <div className="trace-tip-row trace-tip-aside" title={`${fmtInt(asideValue)} ${unit}, not drawn on the chart`}><i /><span>{aside!.label}</span><b>{aside!.lower?.has(hover!) ? '≥ ' : ''}{fmtCompact(asideValue)}</b></div>}
          {gaps?.get(hover!)?.map((label) => <div key={label} className="trace-tip-row trace-tip-gap"><i /><span>{label}</span><b>not reported</b></div>)}
          {pinned !== null && onZoom && at.end - at.t >= 3_600_000 && (
            <button type="button" className="trace-tip-open" onClick={() => { setPinned(null); setPointer(null); onZoom(at.t, at.end); }}>Open {at.label}</button>
          )}
          {ghost && hover !== null && ghost[hover] !== undefined && <div className="trace-tip-row trace-tip-ghost" title={ghost[hover] === null ? undefined : `${fmtInt(ghost[hover]!)} ${unit}`}><i /><span>{ghostLabel ?? 'Previous'}</span><b>{ghost[hover] === null ? (ghostSilent?.has(hover) ? 'not reported' : 'no match') : `${ghostLower?.has(hover) ? '≥ ' : ''}${fmtCompact(ghost[hover]!)}`}</b></div>}
        </div>
      )}
    </div>
  );
}

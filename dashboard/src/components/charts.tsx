import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Bucket, DayStack, Heatmap as HeatmapData, Series } from '../lib/analytics';
import { fmtCompact, fmtDay, fmtInt, fmtShortDateTime } from '../lib/format';
import { OTHER_COLOR, seriesColor } from '../lib/modelColors';

export { OTHER_COLOR, seriesColor };

const axisTick = { fill: 'var(--ink-3)', fontSize: 11 };

interface TipPayload { name?: string; value?: number; color?: string; payload?: Record<string, unknown> }
function ChartTip({ active, payload, title, unit, compact }: { active?: boolean; payload?: readonly TipPayload[]; title?: (p: Record<string, unknown>) => string; unit?: string; compact?: boolean }) {
  if (!active || !payload?.length) return null;
  const show = compact ? fmtCompact : fmtInt;
  const row = payload[0].payload ?? {};
  const items = payload.filter((p) => (p.value ?? 0) > 0);
  const total = payload.reduce((s, p) => s + (p.value ?? 0), 0);
  return (
    <div className="chart-tip">
      <strong>{title?.(row)}</strong>
      {payload.length > 1 ? (
        <>
          {[...items].reverse().map((p) => (
            <div key={p.name} className="chart-tip-row"><span className="swatch" style={{ background: p.color }} />{p.name}<b>{show(p.value ?? 0)}</b></div>
          ))}
          <div className="chart-tip-row chart-tip-total">Total<b>{show(total)}</b></div>
        </>
      ) : (
        <div className="chart-tip-row">{total === 0 ? `No ${unit ?? 'records'} observed` : <>{unit ?? 'Records'}<b>{show(total)}</b></>}</div>
      )}
    </div>
  );
}

export function ActivityChart({ series, tz, height = 240, unit = 'prompts' }: { series: Series; tz: string; height?: number; unit?: string }) {
  const data = useMemo(() => series.points.map((p: Bucket) => ({ ...p })), [series]);
  const isHour = series.unit === 'hour';
  const tick = (iso: string) => (isHour ? fmtShortDateTime(iso, tz) : fmtDay(iso, tz));
  const byDay = isHour && series.points.length > 48;
  const axisTickLabel = (iso: string) => (byDay ? fmtDay(iso, tz) : tick(iso));
  // Hours labelled by their day get one tick per day, so the same date is never written twice.
  const dayTicks = useMemo(() => (byDay ? series.points.filter((p: Bucket, i: number, all: Bucket[]) => !i || fmtDay(p.iso, tz) !== fmtDay(all[i - 1].iso, tz)).map((p: Bucket) => p.iso) : undefined), [byDay, series, tz]);
  return (
    <div className="chart" style={{ blockSize: height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--line)" vertical={false} />
          <XAxis dataKey="iso" ticks={dayTicks} tickFormatter={axisTickLabel} minTickGap={72} tick={axisTick} axisLine={{ stroke: 'var(--line-strong)' }} tickLine={false} />
          <YAxis allowDecimals={false} width={36} tick={axisTick} axisLine={false} tickLine={false} tickFormatter={fmtCompact} />
          <Tooltip cursor={{ stroke: 'var(--line-strong)' }} content={<ChartTip unit={unit} title={(p) => tick(String(p.iso))} />} isAnimationActive={false} />
          <Area type="linear" dataKey="value" name={unit} stroke="var(--accent)" strokeWidth={2} fill="var(--accent)" fillOpacity={0.1} isAnimationActive={false} activeDot={{ r: 4, stroke: 'var(--bg)', strokeWidth: 2, fill: 'var(--accent)' }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ColumnChart({ points, tz, height = 200, unit = 'prompts' }: { points: Bucket[]; tz: string; height?: number; unit?: string }) {
  return (
    <div className="chart" style={{ blockSize: height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--line)" vertical={false} />
          <XAxis dataKey="iso" tickFormatter={(v) => fmtDay(v, tz)} minTickGap={36} tick={axisTick} axisLine={{ stroke: 'var(--line-strong)' }} tickLine={false} />
          <YAxis allowDecimals={false} width={36} tick={axisTick} axisLine={false} tickLine={false} tickFormatter={fmtCompact} />
          <Tooltip cursor={{ fill: 'var(--wash)' }} content={<ChartTip unit={unit} title={(p) => fmtDay(p.iso, tz)} />} isAnimationActive={false} />
          <Bar dataKey="value" name={unit} fill="var(--accent)" maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface StackSeries { key: string; label: string; color: string }

export function StackedDays({ rows, series, height = 240, compactValues }: { rows: DayStack[]; series: StackSeries[]; height?: number; compactValues?: boolean }) {
  return (
    <>
      <div className="chart" style={{ blockSize: height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis dataKey="label" minTickGap={24} tick={axisTick} axisLine={{ stroke: 'var(--line-strong)' }} tickLine={false} />
            <YAxis allowDecimals={false} width={36} tick={axisTick} axisLine={false} tickLine={false} tickFormatter={fmtCompact} />
            <Tooltip cursor={{ fill: 'var(--wash)' }} content={<ChartTip compact={compactValues} title={(p) => String(p.label)} />} isAnimationActive={false} />
            {series.map((s) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} stackId="a" fill={s.color} stroke="var(--bg)" strokeWidth={2} maxBarSize={28} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <Legend items={series} />
    </>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="legend">
      {items.map((s) => <li key={s.label}><span className="swatch" style={{ background: s.color }} aria-hidden="true" />{s.label}</li>)}
    </ul>
  );
}

export { ActivityHeatmap } from './heatmap';

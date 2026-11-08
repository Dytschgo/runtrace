import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Cpu, Folder, Minus } from 'lucide-react';
import { Counter } from '../../components/motion';
import { CoverageBar, plural, Tokens, Unknown } from '../../components/ui';
import type { TokenSummary } from '../../lib/analytics';
import { fmtInt, fmtPct, isKnown } from '../../lib/format';
import { modelIcon, providerIcon } from '../../lib/icons';
import type { GroupBy, LineTotal } from '../../lib/series';

/** The small pieces of the Overview: change arrows, a row of the group list, the token-type bar and the not-captured cells. */
const isFlat = (change: number) => Math.abs(change) < 0.005;
export const signedPct = (change: number) => (isFlat(change) ? '0%' : `${change > 0 ? '+' : ''}${fmtPct(change)}`);
export function ChangeArrow({ change }: { change: number }) {
  if (isFlat(change)) return <Minus size={13} aria-hidden="true" />;
  return change > 0 ? <ArrowUpRight size={13} aria-hidden="true" /> : <ArrowDownRight size={13} aria-hidden="true" />;
}

/** One row of the list: a logo in its colour, its share of the window, and a line drawn to scale. */
export function GroupLine({ line, total, top, by, unit, draft, focused, seriesKey, onFocus, selected, onToggle, why, tabIndex, onRove, offChart, unknown }: {
  line: LineTotal; total: number | null; top: number; by: GroupBy; unit: string; draft: boolean; focused: boolean; seriesKey: string; onFocus: (key: string | null) => void; selected: boolean; onToggle: (key: string) => void; why: string;
  tabIndex: number; onRove: () => void; offChart: boolean; unknown?: { title: string; text: string } | null;
}) {
  const { info, value, turns, reported } = line;
  const atLeast = unit !== 'provider turns' && reported < turns && value > 0;
  // Only nothing measured at all is unknown. Tokens from session logs still count when its turns reported none.
  const silent = turns > 0 && reported === 0 && value === 0;
  // Tokens with no turns behind them come from session-log hours, which are never turns. The row says so instead of reading as tokens from nothing.
  // When grouped by provider a row can hold turns that reported nothing next to session-log hours, so "nothing reported" is the test, not "no turns".
  const logOnly = reported === 0 && value > 0;
  const Icon = by === 'project' ? Folder : info.model ? modelIcon(info.model) : info.provider ? providerIcon(info.provider) : Cpu;
  const share = isKnown(total) && total > 0 ? value / total : 0;
  const body: ReactNode = (
    <>
      <Icon size={15} aria-hidden="true" style={{ color: info.color }} />
      <span className={by === 'model' ? 'model-line-name mono' : 'model-line-name'}>{info.label}</span>
      {unknown ? <b><Unknown label={unknown.title} why={unknown.text} /></b> : silent ? <b><Unknown label={line.partial ? 'Parts only' : 'Not reported'} why={why} /></b> : <b title={`${atLeast ? 'At least ' : ''}${fmtInt(value)} ${unit}`}>{atLeast && <span className="lower-bound"><span aria-hidden="true">≥</span><span className="sr-only">at least </span></span>}<Counter value={value} ms={draft ? 160 : 900} /></b>}
      <small title={logOnly ? "These tokens come from the agents' session logs, kept per hour. Session-log hours are never counted as turns." : undefined}>{unknown ? 'Unknown' : silent ? 'Share unknown' : turns === 0 && value === 0 ? 'No turns here' : fmtPct(share, 1)}{unknown || (turns === 0 && value === 0) ? '' : unit !== 'provider turns' ? ` · ${logOnly ? (turns ? `session logs only · ${plural(turns, 'turn')} reported nothing` : 'session logs only') : reported < turns ? `${fmtInt(reported)} of ${plural(turns, 'turn')}` : plural(turns, 'turn')}` : ''}</small>
      <span className="model-line-share" aria-hidden="true"><i style={{ '--share': value / top, background: info.dashArray ? `repeating-linear-gradient(90deg, ${info.color} 0 6px, transparent 6px 10px)` : info.color } as React.CSSProperties} /></span>
    </>
  );
  return (
    <li data-on={focused ? 'true' : undefined} data-selected={selected ? 'true' : undefined} data-idle={turns === 0 && value === 0 ? 'true' : undefined} data-unnamed={line.key === 'not-recorded' ? 'true' : undefined} onPointerEnter={() => onFocus(seriesKey || null)} onPointerLeave={() => onFocus(null)} onFocus={() => { onRove(); onFocus(seriesKey || null); }} onBlur={() => onFocus(null)}>
      <button type="button" className="model-line" tabIndex={tabIndex} aria-pressed={selected} title={`${selected ? 'Take this out of the selection' : 'Add this to the selection'}${offChart ? '. Not drawn on the chart unless chosen.' : ''}`} onClick={() => onToggle(line.key)}>{body}</button>
    </li>
  );
}

const TYPE_TONES = ['oklch(0.55 0 none)', 'oklch(0.3 0 none)', 'oklch(0.75 0 none)', 'oklch(1 0 none)'];

/** Where the tokens went. Cache reads and writes sit inside input, so the bar shows input without them. A missing field stays hatched. */
export function TokenTypes({ s, partsOnly = 0 }: { s: TokenSummary; partsOnly?: number }) {
  // Turns that reported nothing are not in these sums, so each is at least this much.
  const shortOf = (field: keyof NonNullable<TokenSummary['short']>) => (s.short ? !!s.short[field] : s.turns !== null && s.withUsage !== null && s.withUsage < s.turns);
  const atLeast = (field: keyof NonNullable<TokenSummary['short']>) => (shortOf(field) ? <span className="lower-bound" title="Some turns reported no value here"><span aria-hidden="true">≥</span><span className="sr-only">at least </span></span> : null);
  const known = [s.input, s.cached, s.output].every(isKnown);
  if (!known && s.total === null) return <Unknown why="No token fields are recorded in this view." />;
  const cached = s.cached ?? 0;
  const writes = s.cacheWrite ?? 0;
  const parts = [
    { field: 'input' as const, label: 'Input', value: s.input === null ? null : Math.max(0, s.input - cached - writes), why: 'Input not read from cache.' },
    { field: 'cached' as const, label: 'Cache read', value: s.cached, why: 'Input served from cache.' },
    { field: 'cacheWrite' as const, label: 'Cache write', value: s.cacheWrite ?? null, why: 'Input written to cache. Some providers report no writes.' },
    { field: 'output' as const, label: 'Output', value: s.output, why: 'Text and reasoning the model produced.' },
  ];
  const sum = parts.reduce((t, p) => t + (p.value ?? 0), 0);
  return (
    <>
      <div className="type-bar" role="img" aria-label={parts.map((p) => `${p.label} ${p.value === null ? 'not reported' : fmtInt(p.value)}`).join(', ')}>
        {parts.map((p, i) => <i key={p.label} style={{ flexGrow: sum ? (p.value ?? 0) / sum : 0, background: p.value === null ? undefined : TYPE_TONES[i] }} data-missing={p.value === null ? 'true' : undefined} />)}
      </div>
      <ul className="type-legend">
        {parts.map((p, i) => (
          <li key={p.label} title={p.why}>
            <i style={{ background: TYPE_TONES[i] }} aria-hidden="true" />
            {p.label} <b>{p.value === null ? <Unknown label="Not reported" /> : <>{atLeast(p.field)}<Tokens v={p.value} /></>}</b>
          </li>
        ))}
        {isKnown(s.reasoning) && <li title="Reasoning is included in output.">Reasoning <b>{atLeast('reasoning')}<Tokens v={s.reasoning} /></b></li>}
      </ul>
      {s.turns !== null && s.withUsage !== null && (
        <div className="type-coverage">
          <CoverageBar known={s.withUsage} total={s.turns} label="Provider turns reporting usage" />
          <small>{fmtInt(s.withUsage)} of {fmtInt(s.turns)} turns reported usage{partsOnly > 0 && <span title="These turns reported token fields but no total, so they are left out of the parts above, which add up to the total."> · {plural(partsOnly, 'turn')} with parts but no total left out</span>}</small>
        </div>
      )}
    </>
  );
}

export function GapCell({ label, why }: { label: string; why: string }) {
  return <span className="unknown gap-cell" title={why}>{label}<span className="sr-only">. {why}</span></span>;
}

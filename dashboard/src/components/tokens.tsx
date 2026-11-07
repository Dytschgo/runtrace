import { useMemo } from 'react';
import { stackByDay, type TokenSummary } from '../lib/analytics';
import type { TurnRow } from '../lib/entities';
import { fmtCompact, fmtInt, fmtPct, isKnown } from '../lib/format';
import type { StackSeries } from './charts';
import { OTHER_COLOR, seriesColor } from '../lib/modelColors';
import { CoverageBar, Unknown } from './ui';

const NO_USAGE_WHY = 'No token fields are recorded for these turns.';
/** More lines than this stop being readable. Any others join a gray Other line. */
export const CHART_MODELS = 8;

/** The token ledger. Every figure is what providers reported, with the share of turns behind it always beside it. */
export function TokenFacts({ s }: { s: TokenSummary }) {
  const turns = s.turns ?? 0;
  const withUsage = s.withUsage ?? 0;
  const complete = s.complete ?? 0;
  if ([s.total, s.input, s.cached, s.cacheWrite, s.output, s.reasoning].every((v) => !isKnown(v))) {
    return (
      <>
        <div className="tokens-hero"><Unknown why={NO_USAGE_WHY} /></div>
        <p className="tokens-note">{s.turns === null ? 'This service does not report provider turns yet.' : `None of the ${fmtInt(turns)} provider turns in this view reported usage.`}</p>
      </>
    );
  }
  const cachedShare = isKnown(s.cached) && s.input ? s.cached / s.input : null;
  return (
    <>
      <div className="tokens-hero">
        <strong title={isKnown(s.total) ? `${s.turns !== null && complete < turns ? "At least " : ""}${fmtInt(s.total)} tokens` : undefined}>{isKnown(s.total) ? <>{s.turns !== null && complete < turns && <span className="lower-bound" title="Not every turn reported a total"><span aria-hidden="true">≥</span><span className="sr-only">at least </span></span>}{fmtCompact(s.total)}</> : <Unknown why="Total is available only for turns with complete usage." />}</strong>
        <span>tokens from complete turns</span>
      </div>
      <dl className="facts">
        <div><dt>Input</dt><dd>{amount(s.input)}</dd></div>
        <div><dt>Cached input</dt><dd>{amount(s.cached)}{cachedShare !== null && <small className="fine"> {fmtPct(cachedShare)} of input</small>}</dd></div>
        <div><dt>Cache writes</dt><dd className="cache-write-fact">{amount(s.cacheWrite)}{isKnown(s.cacheWriteTurns) && s.turns !== null && <small className="fine"> recorded for {fmtInt(s.cacheWriteTurns)} of {fmtInt(turns)} turns</small>}</dd></div>
        <div><dt>Output</dt><dd>{amount(s.output)}</dd></div>
        <div><dt>Reasoning</dt><dd>{amount(s.reasoning)}</dd></div>
      </dl>
      {(s.total === null || complete < withUsage) && <p className="fine">Total covers only turns with complete usage, so input can exceed it.</p>}
      <p className="fine">Cached input and cache writes are included in input. Reasoning is included in output.</p>
      {s.turns !== null && (
        <div className="tokens-note">
          <CoverageBar known={withUsage} total={turns} label="Provider turns reporting usage" />
          {fmtInt(withUsage)} of {fmtInt(turns)} turns reported usage, {fmtInt(complete)} of them in full.
        </div>
      )}
      {s.noUsage.length > 0 && (
        <p className="tokens-none" title={NO_USAGE_WHY}>
          No usage reported: {s.noUsage.map((m) => <span key={m} className="usage-chip">{m}</span>)}
        </p>
      )}
    </>
  );
}

function amount(v: number | null | undefined) {
  return isKnown(v) ? <span title={`${fmtInt(v)} tokens`}>{fmtCompact(v)}</span> : <Unknown label="Not reported" />;
}

/** Tokens per local day by model. Colours follow the model's all-time slot, so filtering never repaints one. */
export function useTokenStack(turns: TurnRow[], slots: Map<string, string>, tz: string) {
  return useMemo(() => {
    const visible = new Set([...slots.keys()].slice(0, CHART_MODELS));
    const name = (t: TurnRow) => (t.model && visible.has(t.model) ? t.model : 'Other');
    const data = stackByDay(turns.filter((t) => t.total !== null), (t) => t.occurred_at, name, tz, (t) => t.total!);
    const present = new Set(data.flatMap((d) => Object.keys(d)));
    const series: StackSeries[] = [...visible].filter((m) => present.has(m)).map((m) => ({ key: m, label: m, color: seriesColor(slots.get(m)) }));
    if (present.has('Other')) series.push({ key: 'Other', label: 'Other', color: OTHER_COLOR });
    return { data, series };
  }, [turns, slots, tz]);
}

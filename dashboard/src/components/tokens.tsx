import { useMemo } from 'react';
import { stackByDay, type TokenSummary } from '../lib/analytics';
import type { TurnRow } from '../lib/entities';
import { fmtCompact, fmtInt, fmtPct, isKnown, localParts } from '../lib/format';
import type { StackSeries } from './charts';
import { OTHER_COLOR, seriesColor } from '../lib/modelColors';
import { CoverageBar, Hint, Unknown } from './ui';

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
        <span>{s.turns !== null && complete < turns ? 'tokens reported, at least' : 'tokens reported'} <Hint label="How tokens add up">Cached input and cache writes are included in input. Reasoning is included in output.{(s.total === null || complete < withUsage) && ' Total covers only turns with complete usage, so input can exceed it.'}</Hint></span>
      </div>
      <MixBar input={s.input} cached={s.cached} output={s.output} reasoning={s.reasoning} label="Token mix in this view" />
      <MixKey />
      <dl className="facts">
        <div><dt>Input <small className="fine">incl. cache</small></dt><dd>{amount(s.input)}</dd></div>
        <div><dt>Cached input</dt><dd>{amount(s.cached)}{cachedShare !== null && <small className="fine"> {fmtPct(cachedShare)} of input</small>}</dd></div>
        <div><dt>Cache writes</dt><dd className="cache-write-fact">{isKnown(s.cacheWrite) && isKnown(s.cacheWriteTurns) && s.turns !== null && s.cacheWriteTurns < turns && <span className="lower-bound" title="Not every turn recorded cache writes"><span aria-hidden="true">≥ </span><span className="sr-only">at least </span></span>}{amount(s.cacheWrite)}{isKnown(s.cacheWriteTurns) && s.turns !== null && <small className="fine"> recorded for {fmtInt(s.cacheWriteTurns)} of {fmtInt(turns)} turns</small>}</dd></div>
        <div><dt>Output</dt><dd>{amount(s.output)}</dd></div>
        <div><dt>Reasoning</dt><dd>{amount(s.reasoning)}</dd></div>
      </dl>
      {s.turns !== null && (
        <div className="tokens-note">
          <CoverageBar known={withUsage} total={turns} label="Provider turns reporting usage" />
          {withUsage === turns && complete === turns ? `All ${fmtInt(turns)} turns reported usage` : `${fmtInt(withUsage)} of ${fmtInt(turns)} turns reported usage, ${fmtInt(complete)} in full`}
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

/** What a token total is made of, as one bar: new input, cached input, output and the reasoning inside it. Hatched is a part the provider did not report. */
export function MixBar({ input, cached, output, reasoning, label }: { input: number | null | undefined; cached: number | null | undefined; output: number | null | undefined; reasoning: number | null | undefined; label: string }) {
  const parts: { key: string; v: number; name: string }[] = [];
  const out = isKnown(output) ? output : null;
  const rsn = isKnown(reasoning) && out !== null ? Math.min(reasoning, out) : null;
  if (isKnown(input)) {
    // With no cache figure the split of input is unknown, so it is one striped part, never all "new".
    if (!isKnown(cached)) parts.push({ key: 'input', v: input, name: 'Input, cache split not reported' });
    else {
      const c = Math.min(cached, input);
      parts.push({ key: 'fresh', v: input - c, name: 'New input' });
      if (c) parts.push({ key: 'cached', v: c, name: 'Cached input' });
    }
  }
  if (out !== null) {
    parts.push({ key: 'output', v: out - (rsn ?? 0), name: 'Output' });
    if (rsn) parts.push({ key: 'reason', v: rsn, name: 'Reasoning' });
  }
  const sum = parts.reduce((a, p) => a + p.v, 0);
  const missing = !isKnown(input) || out === null;
  if (!sum && !missing) return null;
  const said = parts.filter((p) => p.v > 0).map((p) => `${p.name} ${fmtPct(p.v / (sum || 1))}`).join(', ');
  return (
    <span className="mix" role="img" aria-label={`${label}: ${said || 'not reported'}${missing ? ', some parts not reported' : ''}`}>
      {parts.filter((p) => p.v > 0).map((p) => <i key={p.key} className={`mix-${p.key}`} style={{ flexGrow: p.v }} title={`${p.name}: ${fmtCompact(p.v)} (${fmtPct(p.v / sum)})`} />)}
      {missing && <i className="mix-missing" style={{ flexGrow: sum ? sum * 0.12 : 1 }} title={!isKnown(input) ? 'Input not reported' : 'Output not reported'} />}
    </span>
  );
}

export function MixKey() {
  return (
    <ul className="mix-key" aria-hidden="true">
      <li><i className="mix-fresh" />New input</li>
      <li><i className="mix-cached" />Cached</li>
      <li><i className="mix-output" />Output</li>
      <li><i className="mix-reason" />Reasoning</li>
    </ul>
  );
}

function amount(v: number | null | undefined) {
  return isKnown(v) ? <span title={`${fmtInt(v)} tokens`}>{fmtCompact(v)}</span> : <Unknown label="Not reported" />;
}

/** Tokens per local day by model. Colours follow the model's all-time slot, so filtering never repaints one. */
export function useTokenStack(turns: TurnRow[], slots: Map<string, string>, tz: string) {
  return useMemo(() => {
    const visible = new Set([...slots.keys()].slice(0, CHART_MODELS));
    // Turns that name no model keep their own band, so the chart adds up with the share above it.
    const name = (t: TurnRow) => (!t.model ? 'Not recorded' : visible.has(t.model) ? t.model : 'Other');
    const data = stackByDay(turns.filter((t) => t.total !== null), (t) => t.occurred_at, name, tz, (t) => t.total!);
    // A day where some of a model's turns reported no total is a lower bound for that model, and the table says so.
    const partial = new Set(turns.filter((t) => t.total === null && !t.log).map((t) => `${localParts(t.occurred_at, tz).date}|${name(t)}`));
    const present = new Set(data.flatMap((d) => Object.keys(d)));
    const series: StackSeries[] = [...visible].filter((m) => present.has(m)).map((m) => ({ key: m, label: m, color: seriesColor(slots.get(m)) }));
    if (present.has('Other')) series.push({ key: 'Other', label: 'Other', color: OTHER_COLOR });
    if (present.has('Not recorded')) series.push({ key: 'Not recorded', label: 'Not recorded', color: 'oklch(0.3 0 none)', hatched: true });
    return { data, series, partial };
  }, [turns, slots, tz]);
}

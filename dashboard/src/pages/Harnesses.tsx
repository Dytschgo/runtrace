import { ModelName } from '../components/model';
import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { StackedDays, type StackSeries, Legend } from '../components/charts';
import { DataTable, type Column } from '../components/DataTable';
import { Async, ChartPanel, NoRecords, NotYetPage, PageHeader, Panel, RankedBars, Segmented, SelectField, SkeletonRows, Unknown } from '../components/ui';
import { stackByDay, weeklyWhenLong, type DayStack } from '../lib/analytics';
import { useFilters, useModelTurns, useProjects, useQuota, useThreads } from '../lib/data';
import { isFuture, previousWindow } from '../lib/filters';
import { fmtCompact, fmtDay, fmtDuration, fmtInt, fmtPct, fmtShortDateTime, localParts, repairText, zonedDayStart } from '../lib/format';
import {
  balanceByDay, balanceShares, harnessByHour, harnessByProject, harnessColor, harnessFamily, harnessName, harnessOf, harnessStats, harnessTotals,
  harnessWeight, limitEpisodes, SMOOTH_AFTER_DAYS, SMOOTH_DAYS, whoFilter, type BalanceDay, type HarnessMeasure, type HarnessStats, type LimitEpisode, type LimitHit, type Who,
} from '../lib/harness';
import { providerIcon } from '../lib/icons';
import { useSettings } from '../lib/settings';
import { useUrl } from '../lib/url';

const PREFERRED: [string, string] = ['claudeAgent', 'codex'];
const WHO: { value: Who; label: string; title: string }[] = [
  { value: 'all', label: 'All turns', title: 'Every provider turn' },
  { value: 'started', label: 'You started', title: 'Turns in threads a person started' },
  { value: 'delegated', label: 'Delegated', title: 'Turns in sub-agent threads, started by another agent' },
];
const WINDOW_NAMES: Record<string, string> = { five_hour: '5-hour limit', seven_day: '7-day limit', weekly: 'weekly limit', primary: '5-hour limit', secondary: 'weekly limit' };
const PROJECTS_SHOWN = 12;

export default function Harnesses() {
  const { params, set } = useUrl();
  const { timezone } = useSettings();
  const f = useFilters();
  const turns = useModelTurns({ ...f, model: undefined });
  const before = previousWindow(f);
  const previous = useModelTurns({ ...f, model: undefined, range: undefined, since: before?.since, until: before?.until }, !!before);
  // Threads say which ones are sub-agents, which is what tells delegated work from turns a person started.
  const threads = useThreads({ project: f.project, instance: f.instance });
  const projects = useProjects();
  const resets = useQuota('quota/resets');
  const measure: HarnessMeasure = params.get('hm') === 'tokens' ? 'tokens' : 'turns';
  const whoParam = params.get('who');
  const who: Who = whoParam === 'started' || whoParam === 'delegated' ? whoParam : 'all';

  const childThreads = useMemo(() => new Set((threads.data?.rows ?? []).filter((t) => t.type === 'child').map((t) => t.source_id)), [threads.data]);
  // Until the threads are in, a split by who started a turn cannot be made, so it waits rather than guessing.
  const whoReady = who === 'all' || !!threads.data;
  const keep = useMemo(() => whoFilter(who, childThreads), [who, childThreads]);
  const rows = useMemo(() => (whoReady ? (turns.data?.rows ?? []).filter(keep) : []), [turns.data, keep, whoReady]);
  const prevRows = useMemo(() => (whoReady ? (previous.data?.rows ?? []).filter(keep) : []), [previous.data, keep, whoReady]);

  const totals = useMemo(() => harnessTotals(rows, measure), [rows, measure]);
  const all = totals.reduce((s, t) => s + t.value, 0);
  const keys = totals.map((t) => t.key);

  // The pair defaults to Claude Code against Codex, or else the two busiest harnesses.
  const pick = (given: string | null, fallback: string, other?: string) =>
    given && keys.includes(given) && given !== other ? given : keys.includes(fallback) && fallback !== other ? fallback : keys.find((k) => k !== other) ?? fallback;
  const a = pick(params.get('ha'), PREFERRED[0]);
  const b = pick(params.get('hb'), PREFERRED[1], a);

  // Each day's own balance, and the one the chart draws: the same, or the trailing week once the window is long.
  const daily = useMemo(() => balanceByDay(rows, a, b, measure, timezone), [rows, a, b, measure, timezone]);
  const span = daily.length > SMOOTH_AFTER_DAYS ? SMOOTH_DAYS : 1;
  const days = useMemo(() => (span === 1 ? daily : balanceByDay(rows, a, b, measure, timezone, span)), [daily, span, rows, a, b, measure, timezone]);
  const shares = useMemo(() => balanceShares(rows, a, b, measure), [rows, a, b, measure]);
  const prevShares = useMemo(() => (before ? balanceShares(prevRows, a, b, measure) : null), [before, prevRows, a, b, measure]);
  // A day read on one pair means nothing on another, so changing the pair, the measure or who started it lets go of it.
  const pairKey = `${a}|${b}|${measure}|${who}|${days.length}`;
  const [held, setHeld] = useState<{ key: string; i: number } | null>(null);
  const hover = held?.key === pairKey ? held.i : null;
  const setHover = (i: number | null) => setHeld(i === null ? null : { key: pairKey, i });
  const focus = hover !== null ? days[hover] ?? null : null;

  const now = Date.now();
  const episodes = useMemo(() => {
    const hits = ((resets.data?.data ?? []) as unknown as LimitHit[]).filter((h) => {
      const at = Date.parse(h.first_hit_at);
      return (!f.since || at >= Date.parse(f.since)) && (!f.until || at <= Date.parse(f.until));
    });
    return limitEpisodes(hits, rows, a, b, measure, now);
  }, [resets.data, rows, a, b, measure, f.since, f.until]); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => harnessStats(rows, childThreads), [rows, childThreads]);
  const byProject = useMemo(() => harnessByProject(rows, measure), [rows, measure]);
  const byHour = useMemo(() => harnessByHour(rows, measure, timezone), [rows, measure, timezone]);
  const projectName = useMemo(() => {
    const names = new Map((projects.data ?? []).map((p) => [p.source_id, repairText(String(p.data?.name ?? p.source_id))]));
    return (id: string) => (id === 'none' ? 'No project' : names.get(id) ?? 'Project not imported');
  }, [projects.data]);

  const series: StackSeries[] = useMemo(() => [...keys].reverse().map((k) => ({ key: k, label: harnessName(k), color: harnessColor(k) })), [keys.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  const stack = useMemo(() => {
    const perDay = stackByDay(rows.filter((t) => harnessWeight(t, measure) !== null), (t) => t.occurred_at, harnessOf, timezone, (t) => harnessWeight(t, measure) ?? 0);
    return weeklyWhenLong(perDay, timezone);
  }, [rows, measure, timezone]);
  const hourRows: DayStack[] = useMemo(() => byHour.map(({ hour, values }) => {
    const label = String(hour).padStart(2, '0');
    return { day: label, label, iso: '', ...Object.fromEntries(values) };
  }), [byHour]);

  if (isFuture(f)) return <NotYetPage title="Harnesses" />;

  const unit = measure === 'turns' ? 'turns' : 'tokens';
  const show = measure === 'turns' ? fmtInt : fmtCompact;
  const options = keys.map((k) => ({ value: k, label: harnessName(k) }));
  const aDays = daily.filter((d) => d.diff !== null && d.diff > 0).length;
  const bDays = daily.filter((d) => d.diff !== null && d.diff < 0).length;
  const shown = focus ? (focus.diff === null ? null : { a: (100 + focus.diff) / 200, b: (100 - focus.diff) / 200 }) : shares;
  const lead = shown ? (shown.a - shown.b) * 100 : null;
  // How far the balance moved since the same length of time just before. Each side counts its own two harnesses only.
  const moved = !focus && shares && prevShares ? (shares.a - prevShares.a) * 200 : null;
  const beforeDays = before ? Math.round((Date.parse(before.until) - Date.parse(before.since)) / 86_400_000) : 0;
  const query = !whoReady ? threads : turns;

  return (
    <>
      <PageHeader
        title="Harnesses"
        lead={(() => {
          const sum = totals.reduce((a, t) => a + t.value, 0);
          const lead0 = [...totals].sort((x, y) => y.value - x.value)[0];
          return lead0 && sum ? <>{harnessName(lead0.key)} ran {fmtPct(lead0.value / sum)} of the {unit}{totals.length > 1 ? `, ${totals.length - 1} other ${totals.length === 2 ? 'harness' : 'harnesses'} the rest` : ''}.</> : 'Which agent ran your turns.';
        })()}
        action={
          <>
            <Segmented label="Who started the turn" value={who} onChange={(v) => set({ who: v === 'all' ? null : v }, { replace: true })} options={WHO} />
            <Segmented label="Measure" value={measure} onChange={(v) => set({ hm: v === 'turns' ? null : v }, { replace: true })} options={[{ value: 'turns', label: 'Turns' }, { value: 'tokens', label: 'Tokens' }]} />
          </>
        }
      />
      <Async query={query as typeof turns} skeleton={<SkeletonRows label="Loading turns" />} isEmpty={() => !totals.length} empty={<Panel><NoRecords /></Panel>}>
        {() => (
          <>
            <div className="split">
              <Panel
                className="grow-2 balance"
                title="Balance"
                hint={`${span === 1 ? 'Daily share' : `Share over the ${SMOOTH_DAYS} days to each day`} of ${unit}, ${harnessName(a)} minus ${harnessName(b)}. Even is 50/50; +20pp means ${harnessName(a)} 60%, ${harnessName(b)} 40%.`}
                action={keys.length > 2 && (
                  <>
                    <SelectField label="First harness" hideLabel value={a} onChange={(v) => set({ ha: v, hb: v === b ? a : b }, { replace: true })} options={options} />
                    <span className="fine" aria-hidden="true">vs</span>
                    <SelectField label="Second harness" hideLabel value={b} onChange={(v) => set({ hb: v, ha: v === a ? b : a }, { replace: true })} options={options} />
                  </>
                )}
              >
                <div className="balance-head" aria-live="polite">
                  <Side id={a} share={shown?.a} />
                  <div className="balance-lead">
                    <small>{focus ? `${focus.covers > 1 ? `${focus.covers} days to ` : ''}${dayLabel(focus.day, timezone)}` : 'This window'} · share between these two</small>
                    {lead === null ? <b className="fine">No {unit}</b> : <b>{lead >= 0 ? '+' : '−'}{Math.abs(lead).toFixed(1)}<i>pp</i></b>}
                    <small>{lead === null ? '' : Math.abs(lead) < 0.05 ? 'Even' : `${harnessName(lead > 0 ? a : b)} leads`}</small>
                    {moved !== null && Math.abs(moved) >= 0.05 && (
                      <small className="balance-moved" title={`Compared with the ${fmtInt(beforeDays)} days just before this window`}>
                        <span>{moved > 0 ? '↑' : '↓'} {Math.abs(moved).toFixed(1)}pp</span> toward {harnessName(moved > 0 ? a : b)} vs the {fmtInt(beforeDays)} days before
                      </small>
                    )}
                  </div>
                  <Side id={b} share={shown?.b} end />
                </div>
                {days.length > 1
                  ? <BalanceChart days={days} a={a} b={b} tz={timezone} gaps={gapRuns(daily)} episodes={episodes} hover={hover} onHover={setHover} show={show} />
                  : <p className="fine">The balance needs at least two days with {unit} from either harness. Widen the time range.</p>}
                <p className="balance-foot fine">
                  <span>{episodes.length ? '▾ a limit was reached' : ''}</span>
                  <span>{harnessName(a)} led {fmtInt(aDays)} days, {harnessName(b)} {fmtInt(bDays)}</span>
                </p>
              </Panel>
              <Panel className="grow-1" title="All harnesses" sub={`Share of all ${unit} in this window`} hint="Tokens count only turns that reported a complete total. Session-log hours add tokens, never turns.">
                <RankedBars
                  label={`Harnesses by ${unit}`}
                  total={all}
                  items={totals.map((t) => ({
                    key: t.key, value: t.value, swatch: harnessColor(t.key), display: show(t.value),
                    label: <HarnessLabel id={t.key} />,
                    note: measure === 'tokens' ? `${fmtInt(t.turns)} turns` : undefined,
                  }))}
                />
              </Panel>
            </div>

            <Panel title="How they compare" hint="Per harness, over the turns in this view. Medians, so one huge turn does not set the number." flush>
              <CompareTable stats={stats} />
            </Panel>

            {episodes.length > 0 && <LimitPanel episodes={episodes} a={a} b={b} tz={timezone} />}

            <div className="split">
              <Panel className="grow-2" title="By project" sub={`Each project's ${unit}, split by harness`}>
                <Legend items={keys.map((k) => ({ label: harnessName(k), color: harnessColor(k) }))} />
                <ProjectSplits rows={byProject.slice(0, PROJECTS_SHOWN)} name={projectName} show={show} order={keys} />
                {byProject.length > PROJECTS_SHOWN && <p className="fine">{fmtInt(byProject.length - PROJECTS_SHOWN)} more projects not shown</p>}
              </Panel>
              <ChartPanel
                className="grow-1"
                title="By hour of day"
                sub="In the display timezone"
                chart={<StackedDays legendFirstOnTop rows={hourRows} series={series} height={220} compactValues={measure === 'tokens'} />}
                table={<StackTable rows={hourRows} series={series} first="Hour" />}
              />
            </div>

            <ChartPanel
              title={`${measure === 'turns' ? 'Turns' : 'Tokens'} per ${stack.unit}, by harness`}
              sub={stack.unit === 'week' ? 'Weeks start on Monday, in the display timezone' : 'In the display timezone'}
              chart={<StackedDays legendFirstOnTop rows={stack.rows} series={series} compactValues={measure === 'tokens'} />}
              table={<StackTable rows={stack.rows} series={series} first={stack.unit === 'week' ? 'Week of' : 'Day'} />}
            />
          </>
        )}
      </Async>
    </>
  );
}

/** Ten days or more with neither harness are hatched, the same rule as every other gap in the product. */
const GAP_DAYS = 10;
function gapRuns(days: BalanceDay[]): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  days.forEach((d, i) => {
    if (d.diff === null) { if (start < 0) start = i; }
    else { if (start >= 0 && i - start >= GAP_DAYS) out.push([start, i - 1]); start = -1; }
  });
  return out;
}

const dayLabel = (day: string, tz: string) => fmtDay(new Date(zonedDayStart(day, tz).getTime() + 12 * 3_600_000).toISOString(), tz);

/** A harness's colour marks its swatch and lines. Text never uses it, so every name reads the same against the background. */
function HarnessLabel({ id, swatch }: { id: string; swatch?: boolean }) {
  const Icon = providerIcon(harnessFamily(id));
  return <span className="harness-label">{swatch && <span className="swatch" style={{ background: harnessColor(id) }} aria-hidden="true" />}<Icon size={14} aria-hidden="true" />{harnessName(id)}</span>;
}

function Side({ id, share, end }: { id: string; share?: number; end?: boolean }) {
  return (
    <div className={end ? 'balance-side is-end' : 'balance-side'}>
      <HarnessLabel id={id} swatch />
      <b>{share === undefined ? '–' : fmtPct(share, 1)}</b>
      <small className="balance-pair">of the pair</small>
      <i className="balance-side-bar" style={{ background: harnessColor(id) }} aria-hidden="true" />
    </div>
  );
}

function StackTable({ rows, series, first }: { rows: DayStack[]; series: StackSeries[]; first: string }) {
  return (
    <table>
      <thead><tr><th scope="col">{first}</th>{series.map((s) => <th key={s.key} scope="col" className="num">{s.label}</th>)}</tr></thead>
      <tbody>{rows.map((d) => <tr key={d.day}><td>{d.label}</td>{series.map((s) => <td key={s.key} className="num">{fmtInt(Number(d[s.key] ?? 0))}</td>)}</tr>)}</tbody>
    </table>
  );
}

const rate = (n: number, of: number) => (of ? fmtPct(n / of, n && n / of < 0.01 ? 1 : 0) : null);

function CompareTable({ stats }: { stats: HarnessStats[] }) {
  const none = (why: string) => <Unknown label="n/a" why={why} />;
  // A rate that is zero for every harness says nothing, so it moves to the download and the note says so.
  const allZero = (get: (s: HarnessStats) => number) => stats.every((s) => get(s) === 0);
  const quietFailed = allZero((s) => s.failed);
  const quietStopped = allZero((s) => s.stopped);
  const maxPer = Math.max(1, ...stats.map((s) => s.tokensPerTurn ?? 0));
  const columns: Column<HarnessStats>[] = [
    { key: 'harness', header: 'Harness', sort: (s) => harnessName(s.key), csv: (s) => harnessName(s.key), render: (s) => <HarnessLabel id={s.key} swatch /> },
    { key: 'turns', header: 'Turns', align: 'end', sort: (s) => s.turns, render: (s) => fmtInt(s.turns) },
    { key: 'tokens', header: 'Tokens', align: 'end', sort: (s) => s.tokens, render: (s) => (s.tokens === null ? <Unknown label="Not reported" why="No turn reported a complete total." /> : <>{(s.withTotal ?? s.turns) < s.turns && <span className="lower-bound" title={`${fmtInt(s.withTotal ?? 0)} of ${fmtInt(s.turns)} turns reported a total`}><span aria-hidden="true">≥ </span><span className="sr-only">at least </span></span>}{fmtCompact(s.tokens)}</>) },
    { key: 'per-turn', header: 'Median tokens per turn', align: 'end', sort: (s) => s.tokensPerTurn, render: (s) => (s.tokensPerTurn === null ? <Unknown label="Not reported" why="No turn reported a complete total." /> : <span className="token-cell"><span className="bar-cell-track" aria-hidden="true"><span style={{ inlineSize: `${(s.tokensPerTurn / maxPer) * 100}%`, background: harnessColor(s.key) }} /></span>{fmtCompact(s.tokensPerTurn)}</span>) },
    { key: 'cache', header: 'Cached input', align: 'end', sort: (s) => s.cacheShare, render: (s) => (s.cacheShare === null ? <Unknown label="Not reported" why="No turn reported both input and cached input." /> : fmtPct(s.cacheShare)) },
    { key: 'time', header: 'Median turn', align: 'end', sort: (s) => s.medianMs, render: (s) => (s.medianMs === null ? none('No turn was timed.') : fmtDuration(s.medianMs)) },
    { key: 'failed', header: 'Failed', csvOnly: quietFailed, align: 'end', sort: (s) => (s.statusKnown ? s.failed / s.statusKnown : null), render: (s) => rate(s.failed, s.statusKnown) ?? none('No turn reported a status.') },
    { key: 'stopped', header: 'Stopped', csvOnly: quietStopped, align: 'end', sort: (s) => (s.statusKnown ? s.stopped / s.statusKnown : null), render: (s) => <span title="Cancelled or interrupted">{rate(s.stopped, s.statusKnown) ?? none('No turn reported a status.')}</span> },
    { key: 'delegated', header: 'Turns in sub-agents', align: 'end', sort: (s) => s.delegated / s.turns, render: (s) => <span title="Turns that ran in a sub-agent thread">{rate(s.delegated, s.turns)}</span> },
    { key: 'spawned', header: 'Turns starting sub-agents', align: 'end', sort: (s) => (s.spawnKnown ? s.spawned / s.spawnKnown : null), render: (s) => rate(s.spawned, s.spawnKnown) ?? none('No turn said whether it started sub-agents.') },
    {
      key: 'models', header: 'Models', className: 'wide-narrow', sort: (s) => s.models[0]?.model ?? null, csv: (s) => s.models.map((m) => `${m.model} ${m.turns}`).join('; '),
      render: (s) => (s.models.length
        ? <span className="compare-models">{s.models.slice(0, 2).map((m) => <span key={m.model}><ModelName model={m.model} /> <small>{fmtPct(m.turns / s.turns)}</small></span>)}{s.models.length > 2 && <small title={s.models.slice(2).map((m) => m.model).join(', ')}>+{s.models.length - 2} more</small>}</span>
        : none('No turn named its model.')),
    },
  ];
 return (
    <>
      {(quietFailed || quietStopped) && <p className="table-gap"><small>No turn {quietFailed && quietStopped ? 'failed or was stopped' : quietFailed ? 'failed' : 'was stopped'} in this view.</small></p>}
      <DataTable rows={stats} columns={columns} rowKey={(s) => s.key} caption="Harnesses compared" defaultSort={{ key: 'turns', dir: 'desc' }} paged={false} exportName="runtrace-harnesses" />
    </>
  );
}

const LIMITS_SHOWN = 6;

function LimitPanel({ episodes, a, b, tz }: { episodes: LimitEpisode[]; a: string; b: string; tz: string }) {
  const pct = (v: number | null) => (v === null ? <span className="sr-only">Does not apply: neither harness ran in this span</span> : fmtPct(v));
  const [open, setOpen] = useState(false);
  const newest = [...episodes].reverse();
  const shown = open ? newest : newest.slice(0, LIMITS_SHOWN);
  return (
    <Panel title="While a limit held" hint={`${harnessName(a)}'s share of ${harnessName(a)} and ${harnessName(b)} until the reset, against the same length of time just before`} flush>
      <div className="table-scroll card-table" tabIndex={0} role="region" aria-label="Limits reached">
        <table>
          <thead><tr><th scope="col">Reached</th><th scope="col">Limit</th><th scope="col" className="num">Refusals</th><th scope="col" className="num" title={`${harnessName(a)}'s share of ${harnessName(a)} and ${harnessName(b)} in the same length of time before the limit`}>Share before</th><th scope="col" className="num" title={`${harnessName(a)}'s share of the two until the reset`}>Share until reset</th><th scope="col" className="num">Waited</th></tr></thead>
          <tbody>
            {shown.map((e) => {
              const change = e.before !== null && e.during !== null ? (e.during - e.before) * 100 : null;
              return (
                <tr key={`${e.harness}-${e.at}`}>
                  <td data-label="Reached">{fmtShortDateTime(new Date(e.at).toISOString(), tz)}</td>
                  <td data-label="Limit" className="wide-narrow"><HarnessLabel id={e.harness} swatch /> <small className="fine">{WINDOW_NAMES[e.window] ?? e.window}</small></td>
                  <td className="num" data-label="Refusals">{fmtInt(e.hits)}</td>
                  <td className="num" data-label="Share before">{pct(e.before)}</td>
                  <td className="num" data-label="Share until reset">{pct(e.during)}{change !== null && Math.abs(change) >= 1 && <small className="fine"> {change > 0 ? '+' : '−'}{Math.abs(change).toFixed(0)}pp</small>}</td>
                  <td className="num" data-label="Waited">{e.until > e.at ? fmtDuration(e.until - e.at) : <Unknown label="Not recorded" why="The reset time of this limit was not recorded, so the wait cannot be measured." />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {newest.length > LIMITS_SHOWN && (
        <button type="button" className="idle-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Show the latest only' : `Show all ${fmtInt(newest.length)}`}
        </button>
      )}
    </Panel>
  );
}

function ProjectSplits({ rows, name, show, order }: { rows: ReturnType<typeof harnessByProject>; name: (id: string) => string; show: (n: number) => string; order: string[] }) {
  // Every bar stacks the harnesses in the same order, so a colour sits in the same place on each row.
  const rank = (k: string) => { const i = order.indexOf(k); return i < 0 ? order.length : i; };
  const top = Math.max(1, ...rows.map((r) => r.total));
  return (
    <ol className="project-splits" aria-label="Projects by harness">
      {rows.map((p) => (
        <li key={p.project}>
          <div className="project-split-meta"><span className="project-split-name">{name(p.project)}</span><span className="num">{show(p.total)}</span></div>
          <div className="project-split-bar" style={{ inlineSize: `${Math.max(4, (p.total / top) * 100)}%` }} role="img" aria-label={p.parts.map((x) => `${harnessName(x.key)} ${fmtPct(x.value / p.total)}`).join(', ')}>
            {[...p.parts].sort((x1, x2) => rank(x1.key) - rank(x2.key)).map((x) => <span key={x.key} title={`${harnessName(x.key)}: ${show(x.value)} (${fmtPct(x.value / p.total)})`} style={{ flexGrow: x.value, background: harnessColor(x.key) }} />)}
          </div>
        </li>
      ))}
    </ol>
  );
}

const W = 1000;
const H = 300;

function BalanceChart({ days, a, b, tz, gaps, episodes, hover, onHover, show }: {
  days: BalanceDay[]; a: string; b: string; tz: string; gaps: [number, number][]; episodes: LimitEpisode[];
  hover: number | null; onHover: (i: number | null) => void; show: (n: number) => string;
}) {
  const uid = useId().replace(/:/g, '');
  // The scale fits the widest lead in view, so a close race does not hug the middle of a ±100 axis.
  const widest = Math.max(0, ...days.map((d) => Math.abs(d.diff ?? 0)));
  const lim = Math.min(100, Math.max(20, Math.ceil(widest / 20) * 20));
  const y = (diff: number) => H / 2 - (diff / lim) * (H / 2);
  const colorA = harnessColor(a);
  const colorB = harnessColor(b);
  const x = (i: number) => (i / (days.length - 1)) * W;
  // Days neither harness ran break the line, so a gap never reads as a tie.
  const runs: { i: number; d: number }[][] = [];
  days.forEach((day, i) => {
    if (day.diff === null) { if (runs[runs.length - 1]?.length) runs.push([]); return; }
    if (!runs.length) runs.push([]);
    runs[runs.length - 1].push({ i, d: day.diff });
  });
  const solo = runs.filter((r) => r.length === 1);
  const line = runs.filter((r) => r.length > 1).map((r) => r.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.d).toFixed(1)}`).join('')).join('');
  const area = runs.filter((r) => r.length > 1).map((r) => `M${x(r[0].i).toFixed(1)},${H / 2}${r.map((p) => `L${x(p.i).toFixed(1)},${y(p.d).toFixed(1)}`).join('')}L${x(r[r.length - 1].i).toFixed(1)},${H / 2}Z`).join('');
  // A limit is marked on the day it was first reached.
  const index = new Map(days.map((d, i) => [d.day, i]));
  const marks = episodes.flatMap((e) => {
    const i = index.get(localParts(new Date(e.at).toISOString(), tz).date);
    return i === undefined ? [] : [{ i, e }];
  });

  const pointAt = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - box.left) / box.width) * (days.length - 1));
    onHover(Math.max(0, Math.min(days.length - 1, i)));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (e.key === 'Escape') return onHover(null);
    if (!step) return;
    e.preventDefault();
    onHover(Math.max(0, Math.min(days.length - 1, (hover ?? (step > 0 ? -1 : days.length)) + step)));
  };
  const ticks = [0, Math.round((days.length - 1) / 3), Math.round(((days.length - 1) * 2) / 3), days.length - 1].filter((v, i, s) => s.indexOf(v) === i);
  const focus = hover !== null ? days[hover] : null;
  const focusMarks = hover !== null ? marks.filter((m) => m.i === hover) : [];

  return (
    <div className="balance-chart">
      <div className="balance-axis-label" aria-hidden="true">
        <span><i className="swatch" style={{ background: colorA }} />{harnessName(a)} leads ↑</span>
        <span>↓ {harnessName(b)} leads<i className="swatch" style={{ background: colorB }} /></span>
      </div>
      <div className="balance-plot">
        <div className="balance-y" aria-hidden="true" title="Percentage points away from 50/50"><span>+{lim}pp</span><span>+{lim / 2}</span><span>Even</span><span>−{lim / 2}</span><span>−{lim}</span></div>
        <div
          className="balance-svg" tabIndex={0} role="img"
          aria-label={`Daily balance of ${harnessName(a)} against ${harnessName(b)}. Use the arrow keys to read each day.`}
          onPointerMove={pointAt} onPointerDown={pointAt} onPointerLeave={() => onHover(null)} onKeyDown={onKey} onBlur={() => onHover(null)}
        >
          {gaps.map(([s0, s1]) => (
            <span key={s0} className="balance-gap" title={`No turns from either, ${dayLabel(days[s0].day, tz)} to ${dayLabel(days[s1].day, tz)}`} style={{ left: `${(x(s0) / W) * 100}%`, width: `${((x(s1) - x(s0)) / W) * 100}%` }} />
          ))}
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <clipPath id={`up${uid}`}><rect x="0" y="0" width={W} height={H / 2} /></clipPath>
              <clipPath id={`dn${uid}`}><rect x="0" y={H / 2} width={W} height={H / 2} /></clipPath>
            </defs>
            {[0.25, 0.75].map((r) => <line key={r} x1="0" x2={W} y1={H * r} y2={H * r} className="balance-grid" vectorEffect="non-scaling-stroke" />)}
            {marks.map(({ i, e }) => <line key={`${e.harness}-${e.at}`} x1={x(i)} x2={x(i)} y1="0" y2={H} className="balance-limit" stroke={harnessColor(e.harness)} vectorEffect="non-scaling-stroke" />)}
            <path d={area} fill={colorA} fillOpacity="0.16" clipPath={`url(#up${uid})`} />
            <path d={area} fill={colorB} fillOpacity="0.1" clipPath={`url(#dn${uid})`} />
            <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="balance-zero" vectorEffect="non-scaling-stroke" />
            <path d={line} fill="none" stroke={colorA} strokeWidth="1.8" strokeLinejoin="round" vectorEffect="non-scaling-stroke" clipPath={`url(#up${uid})`} />
            <path d={line} fill="none" stroke={colorB} strokeWidth="1.8" strokeLinejoin="round" vectorEffect="non-scaling-stroke" clipPath={`url(#dn${uid})`} />
            {hover !== null && <line x1={x(hover)} x2={x(hover)} y1="0" y2={H} className="balance-cursor" vectorEffect="non-scaling-stroke" />}
          </svg>
          {marks.map(({ i, e }) => <i key={`m-${e.harness}-${e.at}`} className="balance-limit-mark" style={{ left: `${(x(i) / W) * 100}%`, color: harnessColor(e.harness) }} aria-hidden="true">▾</i>)}
          {solo.map((r) => <i key={r[0].i} className="balance-dot" style={{ left: `${(x(r[0].i) / W) * 100}%`, top: `${(y(r[0].d) / H) * 100}%`, background: r[0].d >= 0 ? colorA : colorB }} />)}
          {focus?.diff != null && <i className="balance-dot is-focus" style={{ left: `${(x(hover!) / W) * 100}%`, top: `${(y(focus.diff) / H) * 100}%`, background: focus.diff >= 0 ? colorA : colorB }} />}
          {focus && (
            <div className={hover! > days.length / 2 ? 'chart-tip balance-tip is-left' : 'chart-tip balance-tip'} style={{ left: `${(x(hover!) / W) * 100}%` }}>
              <strong>{focus.covers > 1 ? `${focus.covers} days to ${dayLabel(focus.day, tz)}` : dayLabel(focus.day, tz)}</strong>
              <div className="chart-tip-row"><span className="swatch" style={{ background: colorA }} />{harnessName(a)}<b>{show(focus.a)}</b></div>
              <div className="chart-tip-row"><span className="swatch" style={{ background: colorB }} />{harnessName(b)}<b>{show(focus.b)}</b></div>
              {focusMarks.map(({ e }) => <div key={e.at} className="chart-tip-row chart-tip-total">▾ {harnessName(e.harness)} reached its {WINDOW_NAMES[e.window] ?? e.window}</div>)}
            </div>
          )}
        </div>
      </div>
      <div className="balance-x" aria-hidden="true">
        {ticks.map((i) => <span key={i} style={{ left: `${(x(i) / W) * 100}%` }}>{dayLabel(days[i].day, tz)}</span>)}
      </div>
    </div>
  );
}

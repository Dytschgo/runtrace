import { useMemo, useState } from 'react';
import { CircleCheck, CircleGauge, OctagonAlert, RotateCcw, TrendingDown, TriangleAlert } from 'lucide-react';
import { Async, EmptyState, PageHeader, Panel, QualityBadge, Skeleton, Unknown } from '../components/ui';
import { useMinute, useQuota, useQuotaSamples } from '../lib/data';
import { fmtDateTime, fmtShortDateTime, fmtDuration, fmtPct, fmtRelative, isKnown } from '../lib/format';
import { harnessColor, harnessFamily, harnessName, quotaHarness } from '../lib/harness';
import { providerIcon } from '../lib/icons';
import { freshness, leftOf, QUOTA_LOW, quotaCards, quotaPace, spanText, windowLabel, type QuotaCard, type QuotaReading, type QuotaWindow, type SilentHarness } from '../lib/quota';
import { useSettings } from '../lib/settings';

type Row = Record<string, unknown>;

/** Quota is stored under the account's name (claude, codex, grok…); people know it by the harness that spends it. */
const agentName = (p: unknown) => (typeof p === 'string' ? harnessName(quotaHarness(p)) : 'Agent');
const colorOf = (p: unknown) => (typeof p === 'string' ? harnessColor(quotaHarness(p)) : 'var(--ink-2)');
const pct = (v: number, digits = 0) => fmtPct(v / 100, digits);
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
/** Window labels the harnesses gave, by account and window, for the history that only stores the window's id. */
type Labels = Map<string, string>;
const labelOf = (labels: Labels, provider: unknown, window: unknown) => windowLabel(String(window ?? ''), labels.get(`${provider}|${window}`) ?? null);

export default function Quota() {
  const { timezone } = useSettings();
  const current = useQuota('quota/current');
  const live = useQuota('quota/live');
  const windows = useQuota('quota/windows');
  const resets = useQuota('quota/resets');
  // A week, like every other page.
  const [days, setDays] = useState(7);
  const now = useMinute();
  const since = useMemo(() => new Date(Math.floor((now - days * DAY) / 3_600_000) * 3_600_000).toISOString(), [now, days]);
  const samples = useQuotaSamples(since);
  // A service from before the live view does not know the route, so it simply has no live answer.
  const liveRows = useMemo(() => live.data?.data ?? [], [live.data]);
  const labels = useMemo(() => {
    const m: Labels = new Map();
    for (const h of liveRows) for (const w of (Array.isArray(h.windows) ? h.windows : []) as Row[]) if (typeof w.label === 'string') m.set(`${h.quota_key ?? h.harness}|${w.window}`, w.label);
    return m;
  }, [liveRows]);

  return (
    <>
      <PageHeader title="Quota and Resets" />
      <Async query={current} skeleton={<Skeleton height="12rem" label="Loading quota" />}>
        {(c) => (c.data?.length || liveRows.length ? <Live current={c.data ?? []} live={liveRows} samples={samples.data?.data ?? []} tz={timezone} now={now} /> : (
          <Panel>
            <EmptyState icon={<CircleGauge size={20} />} title="No quota snapshots collected">
              <p>{c.reason ?? 'No harness has reported its limits yet. T3 Code checks each harness every few minutes, Runtrace checks the ones T3 does not, Codex reports them with every turn, and Claude Code keeps its latest reading on this machine.'}</p>
            </EmptyState>
          </Panel>
        ))}
      </Async>

      <Panel
        title="Left over time"
        hint="Each line is how much of a limit was left. It falls as work uses it and jumps back up when the limit resets. Red marks are moments a limit refused work."
        action={
          <div className="segmented-mini" role="group" aria-label="Days shown">
            {[3, 7, 14, 30].map((d) => <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>{d}d</button>)}
          </div>
        }
      >
        <Async query={samples} skeleton={<Skeleton height="12rem" label="Loading quota history" />} isEmpty={(s) => !s.data?.length} compact empty={<p className="fine">No readings in this time.</p>}>
          {(s) => <Tracks samples={s.data ?? []} hits={resets.data?.data ?? []} since={Date.parse(since)} until={now} tz={timezone} labels={labels} />}
        </Async>
      </Panel>

      <div className="quota-history">
        <Panel title="Past windows" hint="Windows that have reset, and what was left at the reset. Running windows are in the cards above. Complete means readings no more than 20 minutes apart covered the whole window; partial means more may have been used between readings.">
          <Async query={windows} skeleton={<Skeleton height="6rem" label="Loading windows" />} compact>
            {(w) => { const ended = (w.data ?? []).filter((r) => r.ended !== false); return ended.length ? <WindowTable rows={ended} tz={timezone} labels={labels} /> : <p className="fine">{w.data?.length ? 'No window has reset yet; the running ones are in the cards above.' : <>None recorded. <Unknown label="Unavailable" why={w.reason} /></>}</p>; }}
          </Async>
        </Panel>
        <Panel title="Limits reached" hint="When a harness refused work because a limit ran out, and how long it waited for the reset.">
          <Async query={resets} skeleton={<Skeleton height="6rem" label="Loading limits reached" />} compact>
            {(r) => (r.data?.length ? <HitList rows={r.data} tz={timezone} labels={labels} /> : <p className="fine">No limit ran out in what was recorded.</p>)}
          </Async>
        </Panel>
      </div>
    </>
  );
}

type PaceOf = (card: QuotaCard, w: QuotaWindow) => ReturnType<typeof quotaPace>;

function Live({ current, live, samples, tz, now }: { current: Row[]; live: Row[]; samples: Row[]; tz: string; now: number }) {
  // Readings per window, for the pace each one is being used at.
  const readings = useMemo(() => {
    const m = new Map<string, QuotaReading[]>();
    for (const s of samples) {
      const at = Date.parse(String(s.sampled_at));
      if (!Number.isFinite(at) || !isKnown(s.used_percentage)) continue;
      const reset = typeof s.reset_at === 'string' ? Date.parse(s.reset_at) : NaN;
      const key = `${s.provider}|${s.window}`;
      m.set(key, [...(m.get(key) ?? []), { at, used: s.used_percentage, resetAt: Number.isFinite(reset) ? reset : null }]);
    }
    return m;
  }, [samples]);
  const { cards, silent } = useMemo(() => quotaCards(current, live, quotaHarness), [current, live]);
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const paceOf: PaceOf = (card, w) => quotaPace(readings.get(`${card.key}|${w.window}`) ?? [], w.minutes, w.resetAt, now);
  // One answer to "am I about to run out?": limits with little left, or on pace to run out before they reset.
  const risks = cards.flatMap((card) => card.windows.flatMap((w) => {
    if (w.used === null || (w.resetAt !== null && w.resetAt <= now)) return [];
    const pace = paceOf(card, w);
    const name = <b>{harnessName(card.harness)} · {windowLabel(w.window, w.label)}</b>;
    const key = `${card.key}|${w.window}`;
    const left = leftOf(w.used);
    if (left <= QUOTA_LOW) return [{ key, text: <>{name}: {left <= 0 ? 'nothing' : pct(left)} left{w.resetAt !== null ? <>, resets in {fmtDuration(w.resetAt - now)}</> : null}</> }];
    if (pace?.fullAt != null) return [{ key, text: <>{name} runs out around {clock.format(new Date(pace.fullAt))} at this pace{w.resetAt !== null ? <>, {fmtDuration(w.resetAt - pace.fullAt)} before it resets</> : null} <span className="quota-pace-basis">(projection)</span></> }];
    return [];
  }));
  const known = cards.some((card) => card.windows.some((w) => w.used !== null));
  const anyPace = cards.some((card) => card.windows.some((w) => (readings.get(`${card.key}|${w.window}`)?.length ?? 0) > 1));
  return (
    <>
      {risks.length ? (
        <div className="quota-summary" data-risk="true" role="status">
          <TriangleAlert size={15} aria-hidden="true" />
          <ul>{risks.map((r) => <li key={r.key}>{r.text}</li>)}</ul>
        </div>
      ) : known ? (
        <div className="quota-summary" role="status"><CircleCheck size={15} aria-hidden="true" /><span>Every limit has more than {QUOTA_LOW}% left{anyPace ? ' and, at its current pace, lasts until it resets' : ''}.</span></div>
      ) : null}
      <div className="quota-cards">
        {[...cards].sort((x, y) => Number(risks.some((r) => r.key.startsWith(`${y.key}|`))) - Number(risks.some((r) => r.key.startsWith(`${x.key}|`)))).map((card) => <LiveCard key={card.key} card={card} paceOf={paceOf} clock={clock} tz={tz} now={now} />)}
      </div>
      {silent.length ? <Silent rows={silent} /> : null}
      {!live.length && <p className="fine quota-missing">No live check was found on this machine, so only what Codex and Claude Code record themselves is shown.</p>}
    </>
  );
}

function LiveCard({ card, paceOf, clock, tz, now }: { card: QuotaCard; paceOf: PaceOf; clock: Intl.DateTimeFormat; tz: string; now: number }) {
  const name = harnessName(card.harness);
  const color = harnessColor(card.harness);
  const Icon = providerIcon(harnessFamily(card.harness));
  const fresh = freshness(card.checkedAt, now);
  const who = card.checkedBy === 'runtrace' ? 'Runtrace' : 'T3 Code';
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short' });
  return (
    <section className="panel quota-card" aria-label={`${name} quota`} style={{ '--q': color } as React.CSSProperties}>
      <header className="quota-head">
        <Icon size={16} aria-hidden="true" style={{ color }} />
        <h2>{name}</h2>
        {card.plan && <span className="tag">{card.plan}</span>}
        {card.checkedAt !== null && (
          <span className="quota-fresh" data-state={fresh} title={`${who} last asked ${name} for its limits at ${fmtDateTime(iso(card.checkedAt), tz)}.`}>
            <i aria-hidden="true" />{fresh === 'stale' ? 'not checked since ' : 'checked '}{fmtRelative(iso(card.checkedAt), now)}{card.checkedBy === 'runtrace' && ' by Runtrace'}
          </span>
        )}
      </header>
      {card.windows.map((w) => {
        const label = windowLabel(w.window, w.label);
        const passed = w.resetAt !== null && w.resetAt <= now;
        const left = passed || w.used === null ? null : leftOf(w.used);
        const low = left !== null && left <= QUOTA_LOW;
        const pace = passed || left === null ? null : paceOf(card, w);
        const unused = left === 100 && w.resetAt === null;
        return (
          <div key={w.window} className="quota-window" data-passed={passed ? 'true' : undefined} data-low={low ? 'true' : undefined} data-empty={left !== null && left <= 0 ? 'true' : undefined}>
            <div className="quota-line">
              <span className="quota-name">{low && <TriangleAlert size={13} aria-hidden="true" className="quota-high-icon" />}{label}{low && <span className="sr-only"> (little left)</span>}</span>
              <b>{passed ? <Unknown label="Reset" why="This limit has reset since the last check, so what is left now is unknown until the next one." /> : left === null ? <Unknown label="Unknown" /> : <>{pct(left)} <small>left</small></>}</b>
            </div>
            <div className="quota-meter" role="img" aria-label={passed ? 'Reset since the last check' : left === null ? 'Unknown' : `${pct(left)} left`} title={w.used !== null && !passed ? `${pct(Math.max(0, w.used))} used` : undefined}>
              {left !== null && <span style={{ inlineSize: `${left}%` }} />}
            </div>
            <p className="fine quota-reset">
              {passed && w.resetAt !== null ? `Reset ${fmtDateTime(iso(w.resetAt), tz)}, not checked since`
                : unused ? 'Not used yet, so no reset is running'
                : w.resetAt !== null ? <>Resets in <b>{fmtDuration(w.resetAt - now)}</b> <span className="quota-at">· {clock.format(new Date(w.resetAt))}</span></>
                : null}
            </p>
            {pace && (
              <p className="fine quota-pace" data-soon={pace.fullAt !== null ? 'true' : undefined} title={`A projection from the readings of the last ${spanText(pace.basisMs)}, not a reading.${pace.perHour > 0 ? ` About ${pace.perHour.toFixed(1)} points used an hour.` : ''}`}>
                {pace.fullAt !== null ? <TriangleAlert size={12} aria-hidden="true" /> : <TrendingDown size={12} aria-hidden="true" />}
                {pace.fullAt !== null ? <>Runs out around <span className="quota-pace-time">{clock.format(new Date(pace.fullAt))}</span></> : pace.perHour > 0 ? 'Lasts until the reset' : 'Not used lately'}
                <span className="quota-pace-basis"> · projection</span>
              </p>
            )}
            {/* The check already says when; a window read at another time, such as by Codex mid-turn, says its own. */}
            {w.readAt !== null && w.readAt !== card.checkedAt && w.readAt <= now && <p className="fine quota-sampled">Read {fmtRelative(iso(w.readAt), now)}</p>}
          </div>
        );
      })}
      {card.credits && (card.credits.available ?? 0) > 0 && (
        <div className="quota-credits">
          <p className="fine"><RotateCcw size={12} aria-hidden="true" /><b>{card.credits.available} reset credit{card.credits.available === 1 ? '' : 's'}</b>{card.credits.nextExpiresAt !== null && <> · next expires {day.format(new Date(card.credits.nextExpiresAt))}</>}</p>
          {card.credits.options.length > 0 && (
            <ul>{card.credits.options.map((o) => (
              <li key={o.label} title={o.description ?? undefined}>{o.label}{o.available !== null && <> ×{o.available}</>}{o.expiresAt !== null && <span className="fine"> · until {day.format(new Date(o.expiresAt))}</span>}{o.description && <span className="sr-only">: {o.description}</span>}</li>
            ))}</ul>
          )}
        </div>
      )}
    </section>
  );
}

/** Harnesses with no limits to show: local models have none, and some providers send no figures. */
function Silent({ rows }: { rows: SilentHarness[] }) {
  return (
    <section className="quota-silent" aria-label="Harnesses without limits">
      <h2>No limits to show</h2>
      <ul>
        {[...rows].sort((x, y) => Number(x.kind === 'local') - Number(y.kind === 'local')).map((h) => {
          const Icon = providerIcon(harnessFamily(h.harness));
          return (
            <li key={h.harness} data-kind={h.kind}>
              <Icon size={13} aria-hidden="true" />
              <b>{harnessName(h.harness)}</b>
              {h.plan && <span className="tag">{h.plan}</span>}
              {h.kind === 'local' ? <span className="tag">No limit</span> : <span className="unknown">{h.kind === 'failed' ? 'Check failed' : 'Not reported'}</span>}
              <span className="fine">{h.why}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** One track per window: how much of it was left over time. A step line, because a reading holds until the next one. */
const span = (w: string) => (/five|5h|hour|primary/i.test(w) ? 0 : 1);

function Tracks({ samples, hits, since: asked, until, tz, labels }: { samples: Row[]; hits: Row[]; since: number; until: number; tz: string; labels: Labels }) {
  const tracks = useMemo(() => {
    const m = new Map<string, { provider: string; window: string; points: [number, number][]; resetAt: number | null; lastAt: number }>();
    for (const s of samples) {
      const t = Date.parse(String(s.sampled_at)); const v = s.used_percentage;
      if (!Number.isFinite(t) || !isKnown(v)) continue;
      const key = `${s.provider}|${s.window}`;
      const e = m.get(key) ?? { provider: String(s.provider), window: String(s.window), points: [], resetAt: null, lastAt: -Infinity };
      e.points.push([t, leftOf(v)]);
      if (t >= e.lastAt) { e.lastAt = t; const rs = typeof s.reset_at === 'string' ? Date.parse(s.reset_at) : NaN; e.resetAt = Number.isFinite(rs) ? rs : null; }
      m.set(key, e);
    }
    // Short windows first, then weekly ones, so lines of the same rhythm sit together.
    return [...m.values()].map((e) => ({ ...e, points: e.points.sort((a, b) => a[0] - b[0]) })).sort((x, y) => span(x.window) - span(y.window) || x.provider.localeCompare(y.provider));
  }, [samples]);
  // The axis starts at the first reading, so days before anything was read do not take most of the width.
  const firstRead = Math.min(...tracks.flatMap((t) => (t.points.length ? [t.points[0][0]] : [])));
  const since = Number.isFinite(firstRead) ? Math.max(asked, firstRead - (until - firstRead) * 0.02) : asked;
  const W = 1000; const H = 64;
  const x = (t: number) => ((t - since) / Math.max(1, until - since)) * W;
  const y = (v: number) => H - (Math.min(100, Math.max(0, v)) / 100) * (H - 4) - 2;
  const fmtDay = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short' });
  const ticks = Array.from({ length: 5 }, (_, i) => since + ((until - since) * i) / 4);
  return (
    <div className="quota-tracks">
      <svg width="0" height="0" aria-hidden="true" style={{ position: 'absolute' }}><defs><pattern id="quota-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(135)"><rect width="1.2" height="6" fill="oklch(0.55 0 none / 0.55)" /></pattern></defs></svg>
      {tracks.map((tr) => {
        // A 5-hour window is drawn over its last day, so its saw-tooth is readable instead of a sliver at the edge.
        const short = span(tr.window) === 0 && until - since > 2 * 86_400_000;
        const from = short ? until - 86_400_000 : since;
        const x = (t: number) => Math.max(0, ((t - from) / Math.max(1, until - from)) * W);
        let d = '';
        tr.points.forEach(([t, v], i) => { d += i === 0 ? `M${x(t).toFixed(1)} ${y(v).toFixed(1)}` : `H${x(t).toFixed(1)}V${y(v).toFixed(1)}`; });
        if (tr.points.length) d += `H${x(Math.min(until, tr.points[tr.points.length - 1][0] + 6 * 3_600_000)).toFixed(1)}`;
        const marks = hits.filter((h) => h.provider === tr.provider && h.window === tr.window).map((h) => Date.parse(String(h.first_hit_at))).filter((t) => t >= since && t <= until);
        const last = tr.points[tr.points.length - 1];
        const label = `${agentName(tr.provider)} · ${labelOf(labels, tr.provider, tr.window)}`;
        const reset = tr.resetAt !== null && tr.resetAt <= until;
        return (
          <div key={`${tr.provider}|${tr.window}`} className="quota-track">
            <span className="quota-track-name"><i style={{ background: colorOf(tr.provider) }} />{label}{short && <small className="fine quota-track-span">last 24 h</small>}</span>
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label}, ${tr.points.length} readings${last ? `, last ${pct(last[1])} left` : ''}${marks.length ? `, ran out ${marks.length} times` : ''}`}>
              {/* Before the first reading nothing is known, which is hatched rather than blank. */}
              {tr.points.length > 0 && tr.points[0][0] > since && <rect x="0" y="0" width={Math.max(0, x(tr.points[0][0]))} height={H} className="quota-before" fill="url(#quota-hatch)"><title>No readings before this</title></rect>}
              <line x1="0" x2={W} y1={y(0)} y2={y(0)} className="quota-full" />
              <line x1="0" x2={W} y1={y(50)} y2={y(50)} className="quota-half" vectorEffect="non-scaling-stroke"><title>50% left</title></line>
              <path d={d} className="quota-path" style={{ stroke: colorOf(tr.provider) }} vectorEffect="non-scaling-stroke" />
              {marks.map((t) => <line key={t} x1={x(t)} x2={x(t)} y1="0" y2={H} className="quota-hit" vectorEffect="non-scaling-stroke"><title>Ran out {fmtDateTime(new Date(t).toISOString(), tz)}</title></line>)}
            </svg>
            {/* After its reset the last reading no longer says what is left now. */}
            <span className="quota-track-last" title={reset ? 'Reset since the last reading, so what is left now is unknown' : last ? `${pct(last[1])} left at the last reading` : undefined}>{reset ? <span className="fine">reset</span> : last ? <>{pct(last[1])}<small> left</small></> : '–'}</span>
            {short && <span className="quota-track-axis" aria-hidden="true"><span>−24 h</span><span>−12 h</span><span>now</span></span>}
            {tr.points.length === 1 && <span className="quota-track-note fine">Collecting since {fmtDateTime(new Date(tr.points[0][0]).toISOString(), tz)}.</span>}
          </div>
        );
      })}
      <div className="quota-axis" aria-hidden="true">{ticks.map((t) => <span key={t}>{fmtDay.format(new Date(t))}</span>)}</div>
    </div>
  );
}

const WINDOWS_SHOWN = 6;

function WindowTable({ rows: all, tz, labels }: { rows: Row[]; tz: string; labels: Labels }) {
  const [open, setOpen] = useState(false);
  const rows = open ? all : all.slice(0, WINDOWS_SHOWN);
  // A coverage that is the same on every row is said once, not repeated in a column.
  const qualities = new Set(all.map((r) => String(r.capture_quality ?? 'partial')));
  const oneQuality = qualities.size === 1 ? [...qualities][0] : null;
  return (
    <>
    <p className="fine quota-one">≤ is the last reading before the reset; less may have been left.{oneQuality && <> Coverage of every window: <QualityBadge quality={oneQuality} /></>}</p>
    <div className="table-scroll quota-table card-table" tabIndex={0} role="region" aria-label="Past quota windows">
      <table>
        <thead><tr><th scope="col">Harness</th><th scope="col">Reset</th><th scope="col">Left at reset</th>{!oneQuality && <th scope="col">Coverage</th>}</tr></thead>
        <tbody>{rows.map((r, i) => {
          // Readings are samples, so the last one before the reset is the least that was used: at most this much was left.
          const left = r.ended === false
            ? (isKnown(r.peak_used_percentage) ? leftOf(r.peak_used_percentage) : null)
            : (isKnown(r.unused_percentage_before_reset) ? r.unused_percentage_before_reset : null);
          return (
            <tr key={i}>
              <td><span className="quota-who"><i style={{ background: colorOf(r.provider) }} />{agentName(r.provider)}</span><small className="fine quota-early">{labelOf(labels, r.provider, r.window)}</small></td>
              <td data-label="Reset">{fmtShortDateTime(r.reset_at, tz)}{typeof r.ended_early_at === 'string' && <small className="fine quota-early">ended early {fmtDateTime(r.ended_early_at, tz)}</small>}</td>
              <td data-label="Left at reset" title={r.ended === false ? 'Still running: at most this much is left, from the latest reading.' : 'From the last reading before the reset. Less may have been left.'}>
                {left === null ? <Unknown label="Unknown" /> : (
                  <span className="left-cell">
                    <span className="left-track" aria-hidden="true"><span style={{ inlineSize: `${Math.max(0, Math.min(100, left))}%`, background: colorOf(r.provider) }} /></span>
                    <b>{left > 0 ? '≤ ' : ''}{pct(left, left > 0 && left < 10 ? 1 : 0)}</b>
                  </span>
                )}
                {r.ended === false && <small className="fine quota-early">still running</small>}
              </td>
              {!oneQuality && <td data-label="Coverage"><QualityBadge quality={String(r.capture_quality ?? 'partial')} /></td>}
            </tr>
          );
        })}</tbody>
      </table>
    </div>
    {all.length > WINDOWS_SHOWN && <button type="button" className="btn btn-quiet fold-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? 'Show fewer' : `Show all ${all.length} windows`}</button>}
    </>
  );
}

function HitList({ rows, tz, labels }: { rows: Row[]; tz: string; labels: Labels }) {
  return (
    <ul className="quota-hits">
      {rows.slice(0, 40).map((r, i) => {
        const first = Date.parse(String(r.first_hit_at)); const reset = Date.parse(String(r.reset_at));
        return (
          <li key={i}>
            <OctagonAlert size={14} aria-hidden="true" className="quota-hit-icon" />
            <span><b>{agentName(r.provider)}</b> {labelOf(labels, r.provider, r.window).toLowerCase()} ran out · {fmtDateTime(r.first_hit_at, tz)}</span>
            <span className="fine">{Number(r.hits) > 1 ? `${r.hits} refusals · ` : ''}{Number.isFinite(reset) && Number.isFinite(first) && reset > first ? `waited ${fmtDuration(reset - first)}` : 'reset not recorded'}</span>
          </li>
        );
      })}
    </ul>
  );
}

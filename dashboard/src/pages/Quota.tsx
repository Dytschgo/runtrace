import { useMemo, useState } from 'react';
import { CircleGauge, OctagonAlert, TrendingUp, TriangleAlert } from 'lucide-react';
import { Async, EmptyState, PageHeader, Panel, QualityBadge, Skeleton, Unknown } from '../components/ui';
import { useMinute, useQuota, useQuotaSamples } from '../lib/data';
import { fmtDateTime, fmtDuration, fmtPct, fmtRelative, isKnown } from '../lib/format';
import { providerIcon } from '../lib/icons';
import { FAMILIES, type Provider } from '../lib/modelColors';
import { PROVIDER_NAMES } from '../lib/series';
import { QUOTA_HIGH, quotaPace, spanText, type QuotaReading } from '../lib/quota';
import { useSettings } from '../lib/settings';

type Row = Record<string, unknown>;

/** Which company an agent's quota belongs to. Anything unknown keeps its own name and a neutral colour. */
const OWNER: Record<string, Provider> = { codex: 'openai', 'codex-meta': 'openai', 'codex-ollama': 'openai', claude: 'anthropic', claudeAgent: 'anthropic', grok: 'xai', muse: 'meta', gemini: 'google' };
const WINDOW_NAMES: Record<string, string> = { five_hour: '5-hour', seven_day: '7-day', seven_day_opus: '7-day Opus', seven_day_sonnet: '7-day Sonnet', weekly: 'Weekly', daily: 'Daily' };
const windowName = (w: unknown) => (typeof w === 'string' ? WINDOW_NAMES[w] ?? w.replace(/_/g, ' ') : 'Window');
const agentName = (p: unknown) => (p === 'codex' ? 'Codex' : p === 'claude' ? 'Claude Code' : typeof p === 'string' ? p : 'Agent');
const owner = (p: unknown) => (typeof p === 'string' ? OWNER[p] ?? null : null);
const colorOf = (p: unknown) => { const o = owner(p); return o ? FAMILIES[o][0] : 'var(--ink-2)'; };
const pct = (v: unknown, digits = 0) => (isKnown(v) ? fmtPct(v / 100, digits) : null);
/** Agents that record no limits on this machine, so nothing can be shown for them. */
const UNRECORDED = ['xai', 'meta'] as const;
const DAY = 86_400_000;

export default function Quota() {
  const { timezone } = useSettings();
  const current = useQuota('quota/current');
  const windows = useQuota('quota/windows');
  const resets = useQuota('quota/resets');
  // A week, like every other page.
  const [days, setDays] = useState(7);
  const now = useMinute();
  const since = useMemo(() => new Date(Math.floor((now - days * DAY) / 3_600_000) * 3_600_000).toISOString(), [now, days]);
  const samples = useQuotaSamples(since);

  return (
    <>
      <PageHeader title="Quota and Resets" lead="What the agents report about their limits. Projections are labelled as projections." />
      <Async query={current} skeleton={<Skeleton height="12rem" label="Loading quota" />}>
        {(c) => (c.data?.length ? <Live rows={c.data} samples={samples.data?.data ?? []} tz={timezone} now={now} /> : (
          <Panel>
            <EmptyState icon={<CircleGauge size={20} />} title="No quota snapshots collected">
              <p>{c.reason ?? 'No agent has reported its limits yet. Codex reports them with every turn, and Claude Code keeps its latest reading on this machine.'}</p>
            </EmptyState>
          </Panel>
        ))}
      </Async>

      <Panel
        title="Usage over time"
        sub="Each line is a window filling up. A drop is a reset. Red marks are moments a limit refused work."
        action={
          <div className="segmented-mini" role="group" aria-label="Days shown">
            {[3, 7, 14, 30].map((d) => <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>{d}d</button>)}
          </div>
        }
      >
        <Async query={samples} skeleton={<Skeleton height="12rem" label="Loading quota history" />} isEmpty={(s) => !s.data?.length} compact empty={<p className="fine">No readings in this time.</p>}>
          {(s) => <Tracks samples={s.data ?? []} hits={resets.data?.data ?? []} since={Date.parse(since)} until={now} tz={timezone} />}
        </Async>
      </Panel>

      <div className="grid-2">
        <Panel title="Reset windows" sub="The last reading before a reset is the most that is known to have been used.">
          <Async query={windows} skeleton={<Skeleton height="6rem" label="Loading windows" />} compact>
            {(w) => (w.data?.length ? <WindowTable rows={w.data} tz={timezone} /> : <p className="fine">None recorded. <Unknown label="Unavailable" why={w.reason} /></p>)}
          </Async>
        </Panel>
        <Panel title="Limits reached" sub="When an agent refused work, and the reset it waited for.">
          <Async query={resets} skeleton={<Skeleton height="6rem" label="Loading limits reached" />} compact>
            {(r) => (r.data?.length ? <HitList rows={r.data} tz={timezone} /> : <p className="fine">No limit reached in what was recorded.</p>)}
          </Async>
        </Panel>
      </div>
    </>
  );
}

function Live({ rows, samples, tz, now }: { rows: Row[]; samples: Row[]; tz: string; now: number }) {
  // Readings per window, for the pace each one is filling at.
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
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  // One card per agent, holding each of its windows.
  const agents = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of rows) {
      const k = String(r.provider ?? r.account ?? 'Agent');
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return [...m.entries()];
  }, [rows]);
  const seen = new Set(agents.map(([p]) => owner(p)).filter(Boolean));
  return (
    <>
      <div className="quota-cards">
        {agents.map(([provider, list]) => {
          const o = owner(provider);
          const Icon = o ? providerIcon(o) : CircleGauge;
          const plan = list.find((r) => typeof r.plan === 'string')?.plan as string | undefined;
          return (
            <section key={provider} className="panel quota-card" aria-label={`${agentName(provider)} quota`} style={{ '--q': colorOf(provider) } as React.CSSProperties}>
              <header className="quota-head">
                <Icon size={16} aria-hidden="true" style={{ color: colorOf(provider) }} />
                <h2>{agentName(provider)}</h2>
                {plan && <span className="tag">{plan}</span>}
              </header>
              {list.map((r, i) => {
                const used = isKnown(r.used_percentage) ? r.used_percentage : isKnown(r.remaining_percentage) ? 100 - r.remaining_percentage : null;
                const left = isKnown(r.remaining_percentage) ? r.remaining_percentage : null;
                const reset = typeof r.reset_at === 'string' ? Date.parse(r.reset_at) : NaN;
                const passed = r.reset_passed === true || (Number.isFinite(reset) && reset <= now);
                const high = !passed && used !== null && used >= QUOTA_HIGH;
                const pace = passed ? null : quotaPace(readings.get(`${provider}|${r.window}`) ?? [], isKnown(r.window_minutes) ? r.window_minutes : null, Number.isFinite(reset) ? reset : null, now);
                return (
                  <div key={String(r.window ?? i)} className="quota-window" data-passed={passed ? 'true' : undefined} data-high={high ? 'true' : undefined}>
                    <div className="quota-line">
                      <span className="quota-name">{high && <TriangleAlert size={13} aria-hidden="true" className="quota-high-icon" />}{windowName(r.window)}{high && <span className="sr-only"> (nearly full)</span>}</span>
                      <b>{passed ? <Unknown label="Reset" why="This window has reset since the last reading, so what is used now is unknown until the agent reports again." /> : used === null ? <Unknown label="Unknown" /> : <>{pct(used)} <small>used</small></>}</b>
                    </div>
                    <div className="quota-meter" role="img" aria-label={passed ? 'Reset since the last reading' : used === null ? 'Unknown' : `${pct(used)} used`}>
                      {!passed && used !== null && <span style={{ inlineSize: `${Math.min(100, Math.max(0, used))}%` }} />}
                    </div>
                    <p className="fine">
                      {passed ? `Reset ${fmtDateTime(r.reset_at, tz)}, no reading since` : <>{left !== null && <>{fmtPct(left / 100, 1)} left · </>}{Number.isFinite(reset) ? <>resets in {fmtDuration(reset - now)} <span className="quota-at">({fmtDateTime(r.reset_at, tz)})</span></> : null}</>}
                    </p>
                    {pace && (
                      <p className="fine quota-pace" data-soon={pace.fullAt !== null ? 'true' : undefined} title={`A projection from the readings of the last ${spanText(pace.basisMs)}, not a reading. ${pace.perHour > 0 ? `About ${pace.perHour.toFixed(1)} points an hour.` : ''}`}>
                        <TrendingUp size={12} aria-hidden="true" />
                        {pace.fullAt !== null ? <>At this pace, full around <span className="quota-pace-time">{clock.format(new Date(pace.fullAt))}</span></> : pace.perHour > 0 ? 'At this pace, lasts until the reset' : 'Not rising lately'}
                        <span className="quota-pace-basis">· projection from {spanText(pace.basisMs)}</span>
                      </p>
                    )}
                    {typeof r.sampled_at === 'string' && <p className="fine quota-sampled">Read {fmtRelative(r.sampled_at, now)}</p>}
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
      <p className="quota-missing">
        {UNRECORDED.filter((p) => !seen.has(p)).map((p) => { const Icon = providerIcon(p); return <span key={p} className="usage-chip" title={`${PROVIDER_NAMES[p]} records no limits on this machine.`}><Icon size={12} aria-hidden="true" style={{ color: FAMILIES[p][0] }} />{PROVIDER_NAMES[p]}<span className="sr-only">: no limits recorded</span></span>; })}
        <span className="fine"> record no limits on this machine.</span>
      </p>
    </>
  );
}

/** One track per agent window: how full it got over time. A step line, because a reading holds until the next one. */
function Tracks({ samples, hits, since, until, tz }: { samples: Row[]; hits: Row[]; since: number; until: number; tz: string }) {
  const tracks = useMemo(() => {
    const m = new Map<string, { provider: string; window: string; points: [number, number][]; resetAt: number | null; lastAt: number }>();
    for (const s of samples) {
      const t = Date.parse(String(s.sampled_at)); const v = s.used_percentage;
      if (!Number.isFinite(t) || !isKnown(v)) continue;
      const key = `${s.provider}|${s.window}`;
      const e = m.get(key) ?? { provider: String(s.provider), window: String(s.window), points: [], resetAt: null, lastAt: -Infinity };
      e.points.push([t, v]);
      if (t >= e.lastAt) { e.lastAt = t; const rs = typeof s.reset_at === 'string' ? Date.parse(s.reset_at) : NaN; e.resetAt = Number.isFinite(rs) ? rs : null; }
      m.set(key, e);
    }
    return [...m.values()].map((e) => ({ ...e, points: e.points.sort((a, b) => a[0] - b[0]) }));
  }, [samples]);
  const W = 1000; const H = 64;
  const x = (t: number) => ((t - since) / Math.max(1, until - since)) * W;
  const y = (v: number) => H - (Math.min(100, Math.max(0, v)) / 100) * (H - 4) - 2;
  const fmtDay = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short' });
  const ticks = Array.from({ length: 5 }, (_, i) => since + ((until - since) * i) / 4);
  return (
    <div className="quota-tracks">
      {tracks.map((tr) => {
        let d = '';
        tr.points.forEach(([t, v], i) => { d += i === 0 ? `M${x(t).toFixed(1)} ${y(v).toFixed(1)}` : `H${x(t).toFixed(1)}V${y(v).toFixed(1)}`; });
        if (tr.points.length) d += `H${x(Math.min(until, tr.points[tr.points.length - 1][0] + 6 * 3_600_000)).toFixed(1)}`;
        const marks = hits.filter((h) => h.provider === tr.provider && h.window === tr.window).map((h) => Date.parse(String(h.first_hit_at))).filter((t) => t >= since && t <= until);
        const last = tr.points[tr.points.length - 1];
        return (
          <div key={`${tr.provider}|${tr.window}`} className="quota-track">
            <span className="quota-track-name"><i style={{ background: colorOf(tr.provider) }} />{agentName(tr.provider)} · {windowName(tr.window)}</span>
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${agentName(tr.provider)} ${windowName(tr.window)} usage, ${tr.points.length} readings${last ? `, last ${pct(last[1])}` : ''}${marks.length ? `, ${marks.length} limits reached` : ''}`}>
              <line x1="0" x2={W} y1={y(100)} y2={y(100)} className="quota-full" />
              <path d={d} className="quota-path" style={{ stroke: colorOf(tr.provider) }} vectorEffect="non-scaling-stroke" />
              {marks.map((t) => <line key={t} x1={x(t)} x2={x(t)} y1="0" y2={H} className="quota-hit" vectorEffect="non-scaling-stroke"><title>Limit reached {fmtDateTime(new Date(t).toISOString(), tz)}</title></line>)}
            </svg>
            {/* After its reset the last reading no longer says what is used now. */}
            <span className="quota-track-last" title={tr.resetAt !== null && tr.resetAt <= until ? 'Reset since the last reading, so what is used now is unknown' : undefined}>{tr.resetAt !== null && tr.resetAt <= until ? <span className="fine">reset</span> : last ? pct(last[1]) : '–'}</span>
            {tr.points.length === 1 && <span className="quota-track-note fine">Collecting since {fmtDateTime(new Date(tr.points[0][0]).toISOString(), tz)}. The agent keeps only its latest reading.</span>}
          </div>
        );
      })}
      <div className="quota-axis" aria-hidden="true">{ticks.map((t) => <span key={t}>{fmtDay.format(new Date(t))}</span>)}</div>
    </div>
  );
}

function WindowTable({ rows, tz }: { rows: Row[]; tz: string }) {
  return (
    <div className="table-scroll quota-table" tabIndex={0} role="region" aria-label="Quota windows">
      <table>
        <thead><tr><th scope="col">Agent</th><th scope="col">Window</th><th scope="col">Reset</th><th scope="col" className="num">Peak used</th><th scope="col" className="num">Unused at reset</th><th scope="col">Quality</th></tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i}>
            <td><span className="quota-who"><i style={{ background: colorOf(r.provider) }} />{agentName(r.provider)}</span></td>
            <td>{windowName(r.window)}</td>
            <td>{fmtDateTime(r.reset_at, tz)}{typeof r.ended_early_at === 'string' && <small className="fine quota-early">ended early {fmtDateTime(r.ended_early_at, tz)}</small>}</td>
            {/* Readings are samples, so the highest one seen is at least what was used and what was left is at most this. */}
            <td className="num" title="The highest reading seen. More may have been used between readings.">{isKnown(r.peak_used_percentage) ? <>≥ {pct(r.peak_used_percentage)}</> : <Unknown label="Unknown" />}</td>
            <td className="num" title="From the last reading before the reset. Less may have been left.">{r.ended === false ? <span className="fine">running</span> : isKnown(r.unused_percentage_before_reset) ? <>≤ {pct(r.unused_percentage_before_reset, 1)}</> : <Unknown label="Unknown" />}</td>
            <td><QualityBadge quality={String(r.capture_quality ?? 'partial')} /></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function HitList({ rows, tz }: { rows: Row[]; tz: string }) {
  return (
    <ul className="quota-hits">
      {rows.slice(0, 40).map((r, i) => {
        const first = Date.parse(String(r.first_hit_at)); const reset = Date.parse(String(r.reset_at));
        return (
          <li key={i}>
            <OctagonAlert size={14} aria-hidden="true" className="quota-hit-icon" />
            <span><b>{agentName(r.provider)}</b> {windowName(r.window)} limit · {fmtDateTime(r.first_hit_at, tz)}</span>
            <span className="fine">{Number(r.hits) > 1 ? `${r.hits} refusals · ` : ''}{Number.isFinite(reset) && Number.isFinite(first) && reset > first ? `waited ${fmtDuration(reset - first)}` : 'reset not recorded'}</span>
          </li>
        );
      })}
    </ul>
  );
}

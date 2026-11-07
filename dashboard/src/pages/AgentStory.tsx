import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowLeft, ExternalLink, Network, Pause, Play, RotateCcw, TriangleAlert } from 'lucide-react';
import { ModelName } from '../components/model';
import { seriesColor } from '../lib/modelColors';
import { AppLink, EmptyState, ErrorState, PageHeader, Panel, Segmented, SkeletonRows, StatusBadge, Tag, Tokens, Unknown, plural } from '../components/ui';
import { useAgents, useFilters, useModelSlots, useThreadTokens, useThreads } from '../lib/data';
import type { ThreadTokens } from '../lib/analytics';
import type { AgentRow } from '../lib/entities';
import { fmtClock, fmtCompact, fmtDateTime, fmtDay, fmtDuration, fmtInt, isKnown } from '../lib/format';
import { useSettings } from '../lib/settings';
import { activeLanes, buildStory, delegateReport, fallbackRoot, findNode, indexAt, latestBefore, type Lane, type Story, type StoryEvent } from '../lib/story';
import { useChildEvents, useFullAgent, usePlayer, useThreadEvents, useWidth, type Pace, type Player } from '../lib/storyHooks';
import { buildForest } from '../lib/tree';
import type { Entity } from '../lib/types';
import { useUrl } from '../lib/url';
import '../styles/story.css';

/**
 * The story of a thread, played back: prompts, turns, tool calls and every sub-agent it delegated to, on one compressed clock.
 * Only recorded events are drawn. Anything the record lacks is hatched or named, never implied.
 */
export default function AgentStory({ id }: { id: string }) {
  const { hrefPage } = useUrl();
  const f = useFilters();
  const threads = useThreads({ instance: f.instance });
  const agents = useAgents({ instance: f.instance });
  const events = useThreadEvents(id);
  // Token totals for the lanes need every turn, so they are read once the story itself is in, or taken from what the overview already read.
  const tokens = useThreadTokens({ instance: f.instance }, !!events.data);

  const thread = threads.data?.rows.find((t) => t.source_id === id) ?? null;
  const forest = useMemo(() => (threads.data && agents.data ? buildForest(threads.data.rows, agents.data.rows) : null), [threads.data, agents.data]);
  const agentsByChild = useMemo(() => { const m = new Map<string, AgentRow>(); for (const a of agents.data?.rows ?? []) if (a.child) m.set(a.child, a); return m; }, [agents.data]);
  const story = useMemo(() => {
    if (!forest || !events.data) return null;
    const root = findNode(forest.roots, id) ?? fallbackRoot(id, thread, events.data.rows.filter((e) => e.kind === 'agent'));
    return buildStory(root, events.data.rows, agentsByChild);
  }, [forest, events.data, id, thread, agentsByChild]);

  const title = thread?.title ?? story?.lanes[0].title ?? (threads.isPending ? 'Loading thread' : 'Thread');
  const error = events.error ?? threads.error ?? agents.error;

  return (
    <>
      <AppLink className="back" href={hrefPage('Threads', { id })}><ArrowLeft size={14} aria-hidden="true" /> Thread</AppLink>
      <PageHeader
        title={title}
        lead={story ? <Lead story={story} /> : events.isPending ? `Reading events… ${fmtInt(events.progress)} so far` : undefined}
        action={
          <>
            <AppLink className="btn" href={hrefPage('Threads', { id })}><ExternalLink size={14} aria-hidden="true" /> Read the thread</AppLink>
            {thread && (thread.root || (story?.lanes.length ?? 0) > 1) && <AppLink className="btn" href={hrefPage('Agent Trees', { root: thread.root ?? id, node: id })}><Network size={14} aria-hidden="true" /> Tree</AppLink>}
          </>
        }
      />
      {error ? <Panel><ErrorState error={error} onRetry={() => { events.refetch(); threads.refetch(); agents.refetch(); }} /></Panel>
        : !story ? <Panel><SkeletonRows rows={6} label="Loading the story" /></Panel>
          : !story.events.length ? (
            <Panel><EmptyState title="Nothing recorded for this thread"><p>No prompts, turns, tool calls or sub-agents are stored against it, so there is nothing to play.</p></EmptyState></Panel>
          ) : <StoryView key={id} id={id} story={story} tokens={tokens} scanComplete={events.data?.complete !== false} scanned={events.data?.scanned ?? 0} />}
    </>
  );
}

function Lead({ story }: { story: Story }) {
  const n = story.events.length - 1;
  const subs = story.lanes.length - 1;
  return (
    <>
      {plural(story.counts.prompts[n], 'prompt')}, {plural(story.counts.tools[n], 'tool call')}
      {story.counts.toolsFailed[n] ? ` (${fmtInt(story.counts.toolsFailed[n])} failed)` : ''}, {plural(subs, 'sub-agent')}
      {story.sends > subs ? ` given ${plural(story.sends, 'task')}` : ''}
      {story.counts.agentsFailed[n] ? ` (${fmtInt(story.counts.agentsFailed[n])} did not finish cleanly)` : ''}, over {fmtDuration(story.axis.spanMs)} of recorded time.
      {story.axis.gaps.length > 0 && ` ${plural(story.axis.gaps.length, 'idle gap')} shortened so the runs stay visible.`}
    </>
  );
}

const PACES: { value: Pace; label: string; title: string }[] = [
  { value: 'quick', label: '12 s', title: 'Play the whole story in twelve seconds' },
  { value: 'normal', label: '30 s', title: 'Play the whole story in thirty seconds' },
  { value: 'slow', label: '90 s', title: 'Play the whole story in ninety seconds' },
];

function StoryView({ id, story, tokens, scanComplete, scanned }: { id: string; story: Story; tokens: Map<string, ThreadTokens>; scanComplete: boolean; scanned: number }) {
  const { params, set, hrefPage } = useUrl();
  const { timezone: tz } = useSettings();
  const slots = useModelSlots();
  const colorOf = useCallback((model: string | null) => seriesColor(model ? slots.get(model) : undefined), [slots]);

  const at = params.get('at');
  const initial = useMemo(() => { const t = at ? Date.parse(at) : NaN; return Number.isNaN(t) ? null : story.axis.toX(t); }, [at, story.axis]);
  const onPause = useCallback((p: number) => set({ at: new Date(story.axis.toT(p)).toISOString() }, { replace: true }), [set, story.axis]);
  const player = usePlayer({ initial, autoplay: initial === null, onPause });

  const selectedKey = params.get('node');
  const selected = story.lanes.find((l) => l.key === selectedKey) ?? null;
  const select = useCallback((key: string | null) => set({ node: key }, { replace: true }), [set]);

  const t = story.axis.toT(player.progress);
  const index = indexAt(story.events, t + 2);
  const seekTo = useCallback((ev: StoryEvent) => player.seek(story.axis.toX(ev.t)), [player, story.axis]);

  // Space plays and pauses, j and k step through the narrated moments, Home and End jump. Typing in a field is left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement;
      const isRange = el.getAttribute?.('type') === 'range';
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? '') && !isRange;
      if (typing || el.isContentEditable) return;
      const onControl = el.tagName === 'BUTTON' || el.tagName === 'A' || isRange || el.getAttribute?.('role') === 'button';
      if (e.key === ' ' && !onControl) { e.preventDefault(); player.toggle(); return; }
      if (e.key === 'j' || e.key === 'k' || ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !onControl)) {
        e.preventDefault();
        const forward = e.key === 'k' || e.key === 'ArrowRight';
        const cur = indexAt(story.narrated, story.axis.toT(player.progressRef.current ?? 0) + 2);
        const next = forward ? story.narrated[cur] : story.narrated[Math.max(0, cur - 2)];
        if (next) seekTo(next);
        else if (!forward) player.seek(0);
        return;
      }
      if (!onControl && e.key === 'Home') { e.preventDefault(); player.seek(0); }
      if (!onControl && e.key === 'End') { e.preventDefault(); player.seek(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [player, story, seekTo]);

  const c = story.counts;
  const i = Math.max(0, index - 1);
  const has = index > 0;
  const count = (arr: Int32Array) => (has ? arr[i] : 0);
  const prompt = latestBefore(story.events, index, 'prompt');
  const answer = latestBefore(story.events, index, 'answer');
  const active = useMemo(() => activeLanes(story.lanes, t, story.axis), [story, t]);
  const log = useMemo(() => {
    const n = indexAt(story.narrated, t + 2);
    return { shown: story.narrated.slice(Math.max(0, n - 12), n), earlier: Math.max(0, n - 12), later: story.narrated.length - n };
  }, [story.narrated, t]);
  const lowerBound = story.gaps.turnsWithoutTotal > 0;

  return (
    <div className="story">
      <section className="panel story-stage" aria-label="Story stage">
        <Transport player={player} story={story} tz={tz} t={t} />
        <Stage story={story} player={player} selected={selected} onSelect={select} colorOf={colorOf} tz={tz} />
        <p className="fine story-legend">
          <i className="story-key story-key-run" /> Turn of the thread, in its model's colour
          <i className="story-key story-key-idle" /> Waiting for you
          <i className="story-key story-key-prompt" /> Prompt
          <i className="story-key story-key-answer" /> Answer
          <i className="story-key story-key-tool" /> Tool call
          <i className="story-key story-key-fail" /> Failure
          <i className="story-key story-key-open" /> No end recorded
          <i className="story-key story-key-gap" /> Idle gap shortened
        </p>
        {(!scanComplete) && (
          <div className="banner banner-soft" role="status"><TriangleAlert size={15} aria-hidden="true" /><span>Only the newest {fmtInt(scanned)} events were read, so the story starts part way in.</span></div>
        )}
      </section>

      <div className="story-grid">
        <Panel title="Now" sub={<><time dateTime={new Date(t).toISOString()}>{fmtDay(new Date(t).toISOString(), tz)} {fmtClock(new Date(t).toISOString(), tz)}</time>, {fmtDuration(Math.max(0, t - story.axis.start))} in</>} className="story-now">
          <dl className="story-counts" aria-label="Running totals at the playhead">
            <div><dt>Prompts</dt><dd>{fmtInt(count(c.prompts))}</dd></div>
            <div><dt>Answers</dt><dd>{fmtInt(count(c.answers))}</dd></div>
            <div><dt>Tool calls</dt><dd>{fmtInt(count(c.tools))}{count(c.toolsFailed) > 0 && <small className="story-crit"> {fmtInt(count(c.toolsFailed))} failed</small>}</dd></div>
            <div><dt>Tasks delegated</dt><dd>{fmtInt(count(c.spawned))}{active.length > 0 && <small> {fmtInt(active.length)} running</small>}{count(c.agentsFailed) > 0 && <small className="story-crit"> {fmtInt(count(c.agentsFailed))} failed</small>}</dd></div>
            <div><dt>Tokens, complete turns</dt><dd>{has && c.turnsWithTotal[i] > 0 ? <span title={`${fmtInt(c.tokens[i])} tokens from ${fmtInt(c.turnsWithTotal[i])} provider turns with a complete total`}>{lowerBound ? '≥ ' : ''}{fmtCompact(c.tokens[i])}</span> : story.gaps.turns === 0 ? <Unknown why="No provider turn is recorded for this thread." /> : <Unknown label="None yet" why="No provider turn with a complete total has happened yet at this point." />}</dd></div>
          </dl>
          {prompt ? (
            <div className="story-prompt">
              <h3>Latest prompt <time className="fine" dateTime={new Date(prompt.t).toISOString()}>{fmtClock(new Date(prompt.t).toISOString(), tz)}</time></h3>
              {delegateReport(prompt.text) ? <p className="story-text">{delegateReport(prompt.text)}</p> : prompt.text ? <p className="story-text">{prompt.text}{prompt.truncated && <span className="fine"> … cut at 512 characters; the thread page has the rest.</span>}</p> : <p className="fine">Text withheld by capture policy.</p>}
            </div>
          ) : <p className="fine">No prompt yet at this point of the story.</p>}
          {active.length > 0 && (
            <div className="story-active">
              <h3>Running now</h3>
              <ul>
                {active.slice(0, 8).map((l) => (
                  <li key={l.key}>
                    <button type="button" className="story-lane-btn" onClick={() => select(l.key)} aria-pressed={selected?.key === l.key}>
                      <i className="swatch" style={{ background: colorOf(l.model) }} aria-hidden="true" />
                      <span className="story-lane-title">{l.title}</span>
                      {l.model && <span className="mono fine">{l.model}</span>}
                    </button>
                  </li>
                ))}
                {active.length > 8 && <li className="fine">and {fmtInt(active.length - 8)} more</li>}
              </ul>
            </div>
          )}
          {answer && (
            <div className="story-answer">
              <h3>Latest answer {answer.model && <span className="mono fine">{answer.model}</span>} <time className="fine" dateTime={new Date(answer.t).toISOString()}>{fmtClock(new Date(answer.t).toISOString(), tz)}</time></h3>
              {answer.text ? <p className="story-text story-text-dim">{answer.text}{answer.truncated && <span className="fine"> …</span>}</p> : <p className="fine">Text withheld by capture policy.</p>}
            </div>
          )}
        </Panel>

        <Panel title="Story so far" sub={log.earlier ? `${fmtInt(log.earlier)} earlier moments, ${fmtInt(log.later)} still to come` : log.later ? `${fmtInt(log.later)} moments still to come` : 'Every narrated moment has played'} className="story-log-panel">
          {log.shown.length ? (
            <ol className="story-log" aria-live="off">
              {log.shown.map((ev) => (
                <li key={ev.id} className={`story-line story-line-${ev.kind}${ev.failed ? ' is-failed' : ''}`}>
                  <button type="button" onClick={() => seekTo(ev)} title="Move the playhead here">
                    <time dateTime={new Date(ev.t).toISOString()}>{fmtClock(new Date(ev.t).toISOString(), tz)}</time>
                    <span>{ev.line}</span>
                  </button>
                </li>
              ))}
            </ol>
          ) : <p className="fine">Nothing has happened yet. Press play, or drag the playhead.</p>}
        </Panel>

        <Panel title={selected ? (selected.row === 0 ? 'This thread' : 'Sub-agent') : 'Select a lane'} sub={selected?.title ?? 'Click a lane on the stage, or a running sub-agent, to read what it was asked and what it returned.'} className="story-detail">
          {selected && <LaneDetail lane={selected} story={story} tz={tz} tokens={tokens.get(selected.thread ?? selected.key)?.total ?? null} colorOf={colorOf} hrefPage={hrefPage} selfId={id} />}
        </Panel>
      </div>

      <GapsNote story={story} scanComplete={scanComplete} />
    </div>
  );
}

function Transport({ player, story, tz, t }: { player: Player; story: Story; tz: string; t: number }) {
  const rangeRef = useRef<HTMLInputElement>(null);
  useEffect(() => player.onFrame((p) => { if (rangeRef.current) rangeRef.current.value = String(Math.round(p * 1000)); }), [player]);
  const when = new Date(t).toISOString();
  return (
    <div className="story-transport">
      <button type="button" className="icon-btn story-play" onClick={player.toggle} aria-label={player.playing ? 'Pause' : 'Play'} aria-pressed={player.playing} title={player.playing ? 'Pause (space)' : 'Play (space)'}>
        {player.playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
      </button>
      <button type="button" className="icon-btn" onClick={player.restart} aria-label="Restart" title="Restart from the first recorded moment"><RotateCcw size={15} aria-hidden="true" /></button>
      <label className="story-scrub">
        <span className="sr-only">Playhead</span>
        <input
          ref={rangeRef} type="range" min={0} max={1000} step={1} defaultValue={Math.round(player.progress * 1000)}
          aria-valuetext={`${fmtDateTime(when, tz)}, ${fmtDuration(Math.max(0, t - story.axis.start))} into the story`}
          onInput={(e) => player.seek(Number((e.target as HTMLInputElement).value) / 1000)}
          onKeyDown={(e) => { if (e.key === ' ') { e.preventDefault(); player.toggle(); } }}
        />
      </label>
      <span className="story-clock" aria-hidden="true">
        <b>{fmtClock(when, tz)}</b>
        <span>{fmtDay(when, tz)}</span>
      </span>
      <Segmented label="Playback length" value={player.pace} onChange={player.setPace} options={PACES} />
    </div>
  );
}

const FAILED_STATUS = new Set(['failed', 'cancelled', 'interrupted']);
const PAD = 10;
const ROOT_Y = 28;
const SUB_TOP = 58;

function Stage({ story, player, selected, onSelect, colorOf, tz }: { story: Story; player: Player; selected: Lane | null; onSelect: (key: string | null) => void; colorOf: (m: string | null) => string; tz: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const width = useWidth(wrap);
  const clipRef = useRef<SVGRectElement>(null);
  const headRef = useRef<SVGGElement>(null);
  const uid = useId().replace(/:/g, '');
  const subRows = story.rows - 1;
  const rowH = subRows ? Math.max(7, Math.min(22, Math.floor(380 / subRows))) : 0;
  const height = subRows ? SUB_TOP + subRows * rowH + 12 : 64;
  const x = useCallback((f: number) => PAD + f * Math.max(1, width - PAD * 2), [width]);
  const laneY = (row: number) => (row === 0 ? ROOT_Y : SUB_TOP + (row - 1) * rowH + rowH / 2);
  const stroke = Math.max(2, Math.min(4, rowH - 3));

  useEffect(() => player.onFrame((p) => {
    const px = x(p);
    clipRef.current?.setAttribute('width', String(Math.max(0, px)));
    headRef.current?.setAttribute('transform', `translate(${px.toFixed(1)} 0)`);
  }), [player, x]);

  const laneByKey = useMemo(() => new Map(story.lanes.map((l) => [l.key, l])), [story.lanes]);
  const subs = story.lanes.slice(1);
  const ordered = useMemo(() => story.lanes.slice().sort((a, b) => (a.x0 ?? 0) - (b.x0 ?? 0) || a.row - b.row), [story.lanes]);

  const toolPath = (failed: boolean) => story.events.filter((e) => e.kind === 'tool' && e.failed === failed && e.lane === story.lanes[0].key)
    .map((e) => `M${x(e.x).toFixed(1)} ${ROOT_Y - (failed ? 7 : 4)}v${failed ? 14 : 8}`).join('');
  const okTools = useMemo(() => toolPath(false), [story, width]); // eslint-disable-line react-hooks/exhaustive-deps
  const badTools = useMemo(() => toolPath(true), [story, width]); // eslint-disable-line react-hooks/exhaustive-deps

  const childTicks = useChildEvents(selected && selected.row > 0 ? selected.thread : null);

  const focusKey = selected?.key ?? story.lanes[0].key;
  const onLaneKey = (e: ReactKeyboardEvent, lane: Lane) => {
    const i = ordered.findIndex((l) => l.key === lane.key);
    const moves: Record<string, () => void> = {
      ArrowDown: () => { if (ordered[i + 1]) onSelect(ordered[i + 1].key); },
      ArrowUp: () => { if (ordered[i - 1]) onSelect(ordered[i - 1].key); },
      Home: () => onSelect(ordered[0].key),
      End: () => onSelect(ordered[ordered.length - 1].key),
      Enter: () => { if (lane.x0 !== null) player.seek(lane.x0); },
    };
    const m = moves[e.key];
    if (m) { e.preventDefault(); e.stopPropagation(); m(); }
  };
  const focusPending = useRef(false);
  useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    wrap.current?.querySelector<SVGGElement>('[tabindex="0"]')?.focus();
  }, [selected]);

  const describe = (l: Lane) => {
    const bits = [l.title];
    if (l.model) bits.push(l.model);
    if (l.row > 0) bits.push(l.status ?? 'status not recorded', l.open ? 'no end recorded' : l.duration !== null ? fmtDuration(l.duration) : '');
    if (l.start !== null) bits.push(`started ${fmtDateTime(new Date(l.start).toISOString(), tz)}`);
    return bits.filter(Boolean).join(', ');
  };

  return (
    <div ref={wrap} className="story-stage-wrap" style={{ '--rows': story.rows } as React.CSSProperties}>
      <svg className="story-svg" width={width} height={height} role="group" aria-label={`${plural(story.lanes.length - 1, 'sub-agent')} on ${plural(story.rows - 1, 'row')}. Use the arrow keys to move between lanes, Enter to move the playhead to one.`}>
        <defs>
          <clipPath id={`${uid}-reveal`}><rect ref={clipRef} x="0" y="0" width="0" height={height} /></clipPath>
          <pattern id={`${uid}-hatch`} patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)"><rect width="1" height="5" fill="var(--hatch-ink)" /></pattern>
        </defs>

        {/* Idle gaps that were shortened, marked across the whole height. */}
        {story.axis.gaps.map((g) => (
          <rect key={g.x} className="story-gap" x={x(g.x) - 3} y={0} width={6} height={height} fill={`url(#${uid}-hatch)`}>
            <title>Idle for {fmtDuration(g.to - g.from)}, shortened</title>
          </rect>
        ))}

        <g clipPath={`url(#${uid}-reveal)`}>
          {/* The thread's own lane: a hairline while waiting for you, solid in the model's colour during each turn. */}
          <line x1={x(0)} x2={x(1)} y1={ROOT_Y} y2={ROOT_Y} className="story-idle" />
          {story.runs.map((r) => (
            r.open
              ? <rect key={r.id} x={x(r.x0)} y={ROOT_Y - 2} width={Math.max(2, x(r.x1) - x(r.x0))} height={4} fill={`url(#${uid}-hatch)`} stroke="var(--line-strong)"><title>Turn with no recorded end, started {fmtDateTime(new Date(r.start).toISOString(), tz)}</title></rect>
              : <rect key={r.id} x={x(r.x0)} y={ROOT_Y - 2} width={Math.max(2, x(r.x1) - x(r.x0))} height={4} rx={1} fill={r.status === 'failed' ? 'var(--crit)' : colorOf(r.model)}><title>{r.model ?? 'Model not recorded'} turn, {fmtDuration((r.end ?? r.start) - r.start)}{r.status && r.status !== 'completed' ? `, ${r.status}` : ''}</title></rect>
          ))}
          <path d={okTools} className="story-tools" />
          <path d={badTools} className="story-tools-failed" />
          {story.events.map((e) => (
            e.kind === 'prompt' ? <g key={e.id} className="story-prompt-mark"><line x1={x(e.x)} x2={x(e.x)} y1={ROOT_Y - 14} y2={ROOT_Y - 3} /><circle cx={x(e.x)} cy={ROOT_Y - 17} r={3.2} /><title>You, {fmtClock(new Date(e.t).toISOString(), tz)}: {e.text?.slice(0, 160) ?? 'text withheld'}</title></g>
              : e.kind === 'answer' ? <g key={e.id} className="story-answer-mark"><circle cx={x(e.x)} cy={ROOT_Y + 12} r={2.8} /><title>{e.model ?? 'Agent'} answered, {fmtClock(new Date(e.t).toISOString(), tz)}: {e.text?.slice(0, 160) ?? 'text withheld'}</title></g>
                : null
          ))}

          {/* Sub-agent lanes, each leaving its parent lane where it was spawned. */}
          {subs.map((l) => {
            if (l.x0 === null || l.x1 === null) return null;
            const ly = laneY(l.row);
            const parent = (l.parent && laneByKey.get(l.parent)) || story.lanes[0];
            const py = laneY(parent.row);
            const x0 = x(l.x0);
            const x1 = x(l.x1);
            const color = colorOf(l.model);
            const r = Math.min(6, Math.abs(ly - py) / 2, Math.max(1, x1 - x0));
            const dir = ly > py ? 1 : -1;
            const failed = l.status === 'failed';
            const warn = l.status === 'cancelled' || l.status === 'interrupted';
            return (
              <g key={l.key} className={`story-lane${selected?.key === l.key ? ' is-selected' : ''}`} style={{ color }}>
                <path className="story-branch" d={`M${x0.toFixed(1)} ${py}V${(ly - dir * r).toFixed(1)}Q${x0.toFixed(1)} ${ly} ${(x0 + r).toFixed(1)} ${ly}`} />
                {(l.sends.length ? l.sends : [{ x0: l.x0, x1: l.x1, open: l.open, agent: null, start: l.start ?? 0, end: l.end }]).map((s, i) => {
                  const sx0 = x(s.x0) + (i === 0 ? r : 0);
                  const sx1 = x(s.x1);
                  const status = s.agent?.status ?? (i === 0 ? l.status : null);
                  const sFailed = i === 0 && !s.agent ? failed : status === 'failed';
                  const sWarn = i === 0 && !s.agent ? warn : status === 'cancelled' || status === 'interrupted';
                  return (
                    <g key={i}>
                      {i > 0 && <circle className="story-send" cx={x(s.x0)} cy={ly} r={Math.min(3.5, stroke)} />}
                      {s.open
                        ? <rect className="story-lane-open" x={sx0} y={ly - stroke / 2} width={Math.max(2, sx1 - sx0)} height={stroke} fill={`url(#${uid}-hatch)`} />
                        : <line className="story-lane-line" x1={sx0} x2={Math.max(sx0 + 1, sx1)} y1={ly} y2={ly} strokeWidth={stroke} />}
                      {!s.open && (sFailed
                        ? <g className="story-end story-end-fail" transform={`translate(${sx1.toFixed(1)} ${ly})`}><line x1={-3.5} y1={-3.5} x2={3.5} y2={3.5} /><line x1={-3.5} y1={3.5} x2={3.5} y2={-3.5} /></g>
                        : sWarn ? <rect className="story-end story-end-warn" x={sx1 - 3} y={ly - 3} width={6} height={6} />
                          : status === 'completed' ? <circle className="story-end story-end-ok" cx={sx1} cy={ly} r={Math.min(3, stroke)} /> : null)}
                    </g>
                  );
                })}
              </g>
            );
          })}

          {/* The selected sub-agent's own tool calls, once its thread has been read. */}
          {selected && selected.row > 0 && childTicks.data && (
            <path className="story-tools story-tools-child" d={childTicks.data.filter((e) => e.kind === 'tool').map((e) => { const tt = Date.parse(e.occurred_at); return Number.isNaN(tt) ? '' : `M${x(story.axis.toX(tt)).toFixed(1)} ${laneY(selected.row) - stroke / 2 - 3}v${stroke + 6}`; }).join('')} />
          )}
        </g>

        {/* Hit areas and keyboard focus for every lane, drawn above the reveal so a lane can be chosen before it plays. */}
        {story.lanes.map((l) => {
          if (l.row > 0 && (l.x0 === null || l.x1 === null)) return null;
          const ly = laneY(l.row);
          const h = l.row === 0 ? 44 : Math.max(rowH, 10);
          const x0 = l.row === 0 ? x(0) : x(l.x0!);
          const w = l.row === 0 ? x(1) - x(0) : Math.max(8, x(l.x1!) - x0);
          return (
            <g key={l.key} className={`story-hit${selected?.key === l.key ? ' is-selected' : ''}`} role="button" tabIndex={focusKey === l.key ? 0 : -1} aria-pressed={selected?.key === l.key} aria-label={describe(l)}
              onClick={() => onSelect(l.key)} onKeyDown={(e) => { focusPending.current = true; onLaneKey(e, l); }} onFocus={() => { if (selected?.key !== l.key) onSelect(l.key); }}>
              <rect x={x0 - 4} y={ly - h / 2} width={w + 8} height={h} rx={3} />
              <title>{describe(l)}</title>
            </g>
          );
        })}
        {selected && selected.row > 0 && selected.x0 !== null && (
          <text className="story-lane-label" x={Math.min(x(selected.x0), width - 160)} y={laneY(selected.row) - stroke / 2 - 4} aria-hidden="true">{selected.title.slice(0, 48)}{selected.title.length > 48 ? '…' : ''}</text>
        )}

        <g ref={headRef} className="story-head" aria-hidden="true">
          <line x1={0} x2={0} y1={4} y2={height} />
          <path d="M-4 0h8l-4 5z" />
        </g>
      </svg>
    </div>
  );
}

function LaneDetail({ lane, story, tz, tokens, colorOf, hrefPage, selfId }: { lane: Lane; story: Story; tz: string; tokens: number | null; colorOf: (m: string | null) => string; hrefPage: ReturnType<typeof useUrl>['hrefPage']; selfId: string }) {
  const agent = lane.sends[0]?.agent ?? lane.node.agent;
  const full = useFullAgent(agent?.source_id ?? null);
  const child = useChildEvents(lane.row > 0 ? lane.thread : null);
  const text = full.data ?? agent;
  const summary = useMemo(() => summarise(child.data ?? []), [child.data]);
  const isRoot = lane.row === 0;
  const kids = story.lanes.filter((l) => l.parent === lane.key).length;
  return (
    <>
      <dl className="facts">
        <div><dt>Model</dt><dd>{lane.model ? <ModelName model={lane.model} /> : <Unknown label="Not recorded" why="No model is recorded for this lane." />}</dd></div>
        {!isRoot && <div><dt>Status</dt><dd><StatusBadge status={lane.status} /></dd></div>}
        {!isRoot && lane.sends.length > 1 && <div><dt>Tasks sent</dt><dd>{fmtInt(lane.sends.length)}<small className="fine"> {lane.sends.filter((s) => s.agent?.status === 'completed').length} completed{lane.sends.some((s) => s.agent && FAILED_STATUS.has(s.agent.status ?? '')) ? <span className="story-crit">, {lane.sends.filter((s) => s.agent && FAILED_STATUS.has(s.agent.status ?? '')).length} not cleanly</span> : ''}</small></dd></div>}
        <div><dt>Started</dt><dd>{lane.start !== null ? fmtDateTime(new Date(lane.start).toISOString(), tz) : <Unknown label="Unknown" />}</dd></div>
        {!isRoot && <div><dt>{lane.sends.length > 1 ? 'Ran for, all tasks' : 'Ran for'}</dt><dd>{lane.open && lane.duration === null ? <Unknown label="No end recorded" why="No completion time was recorded, so no duration can be shown." /> : <>{fmtDuration(lane.duration ?? ((lane.end ?? 0) - (lane.start ?? 0)))}{lane.open && <small className="fine"> + an open task</small>}</>}</dd></div>}
        {!isRoot && <div><dt>Result delivered</dt><dd>{lane.returned === null ? <Unknown label="Not recorded" why="No explicit delivery record. This does not mean the result was lost." /> : lane.returned ? <Tag>Acknowledged</Tag> : <Tag tone="warn">Not acknowledged</Tag>}</dd></div>}
        <div><dt>Tokens</dt><dd><Tokens v={tokens} why="No provider turn with a complete total is recorded for this thread." /></dd></div>
        {kids > 0 && <div><dt>Delegated to</dt><dd>{plural(kids, 'sub-agent')}</dd></div>}
        {!isRoot && lane.thread && (
          <div><dt>Its own activity</dt><dd>{child.isPending ? <span className="fine">Reading…</span> : child.isError ? <Unknown label="Could not read" /> : summary.total === 0 ? <Unknown label="Nothing stored" why="The sub-agent's thread holds no events." /> : <>{plural(summary.tools, 'tool call')}{summary.failed ? <span className="story-crit">, {fmtInt(summary.failed)} failed</span> : ''}, {plural(summary.answers, 'answer')}{summary.total >= 500 ? ', newest 500 read' : ''}</>}</dd></div>
        )}
        {!isRoot && !lane.thread && <div><dt>Its own activity</dt><dd><Unknown label="No thread" why="A provider-native sub-agent has no thread of its own in the record." /></dd></div>}
      </dl>
      {text?.task && <details className="agent-part" open={lane.row > 0}><summary>{lane.sends.length > 1 ? 'First task' : 'Task'}{full.isPending ? ' (loading full text)' : ''}</summary><div className="message-text message-small">{text.task}</div></details>}
      {text?.result && <details className="agent-part"><summary>{lane.sends.length > 1 ? 'First result' : 'Result'}</summary><div className="message-text message-small">{text.result}</div></details>}
      {lane.sends.slice(1).map((s, i) => s.agent && (
        <details key={s.agent.id} className="agent-part">
          <summary>Task {i + 2} <span className="fine">{fmtClock(new Date(s.start).toISOString(), tz)}, <StatusBadge status={s.agent.status} />{s.end !== null && ` ${fmtDuration(s.end - s.start)}`}</span></summary>
          {s.agent.task && <div className="message-text message-small">{s.agent.task}</div>}
          {s.agent.result && <><h4 className="story-h4">Result</h4><div className="message-text message-small">{s.agent.result}</div></>}
          {!s.agent.task && !s.agent.result && <p className="fine">No task or result text was captured.</p>}
        </details>
      ))}
      {!isRoot && summary.lastAnswer && <details className="agent-part"><summary>Its last answer</summary><div className="message-text message-small">{summary.lastAnswer}</div></details>}
      {!isRoot && !text?.task && !text?.result && agent && <p className="fine">No task or result text was captured for this sub-agent.</p>}
      <div className="story-detail-actions">
        {lane.thread && lane.thread !== selfId && <AppLink className="btn" href={hrefPage('Threads', { id: lane.thread, story: '1' })}><Play size={14} aria-hidden="true" /> Play its story</AppLink>}
        {lane.thread && <AppLink className="btn" href={hrefPage('Threads', { id: lane.thread })}><ExternalLink size={14} aria-hidden="true" /> Open thread</AppLink>}
      </div>
      <span className="sr-only">Lane colour {colorOf(lane.model)}</span>
    </>
  );
}

function summarise(events: Entity[]) {
  let tools = 0, failed = 0, answers = 0;
  let lastAnswer: string | null = null;
  for (const e of events) {
    if (e.kind === 'tool') { tools++; if (e.data?.status === 'failed' || (isKnown(e.data?.exit_code) && e.data.exit_code !== 0)) failed++; }
    if (e.kind === 'answer') { answers++; if (!lastAnswer && typeof e.data?.content_redacted === 'string') lastAnswer = e.data.content_redacted; }
  }
  return { tools, failed, answers, total: events.filter((e) => e.kind !== 'thread').length, lastAnswer };
}

function GapsNote({ story, scanComplete }: { story: Story; scanComplete: boolean }) {
  const g = story.gaps;
  const items: string[] = [];
  if (g.agentsNoEnd) items.push(`${plural(g.agentsNoEnd, 'sub-agent has', 'sub-agents have')} no recorded end`);
  if (g.agentsDeliveryUnknown) items.push(`delivery of ${plural(g.agentsDeliveryUnknown, 'result')} was not recorded`);
  if (g.runsNoEnd) items.push(`${plural(g.runsNoEnd, 'turn has', 'turns have')} no recorded end`);
  if (g.turns && g.turnsWithoutTotal) items.push(`${fmtInt(g.turnsWithoutTotal)} of ${plural(g.turns, 'provider turn')} reported no complete token total`);
  if (!g.turns) items.push('no provider turns, so no tokens');
  if (g.toolsNoStatus) items.push(`${plural(g.toolsNoStatus, 'tool call has', 'tool calls have')} no status`);
  if (g.withheld) items.push(`${plural(g.withheld, 'message')} withheld by capture policy`);
  if (!scanComplete) items.push('older events were not read');
  return (
    <p className="fine story-gaps">
      <span className="unknown unknown-inline">Not in the record</span> Which model actually served each turn is never recorded. Tool calls inside sub-agents are read only for the selected lane. Text previews stop at 512 characters.
      {items.length > 0 && <> Here, {items.join('; ')}.</>}
    </p>
  );
}

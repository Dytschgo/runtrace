import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { isTypingTarget } from '../lib/keys';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import { useFilters, useHourly, useMinute } from '../lib/data';
import { RANGES } from '../lib/filters';
import { useSettings } from '../lib/settings';
import { endEdge, moveWindow, rangeFromWindow, setWindowDraft, sliderDomain, startEdge, stepWindow, windowFromFilters, zoomRange, type SlotUnit, type SlotWindow } from '../lib/timeWindow';
import { useUrl } from '../lib/url';

type Grip = 'start' | 'end' | 'both';

/** The page's main control: two handles over real prompts. It moves in days, and in hours once zoomed in. */
export function TimeSlider() {
  const { set, params } = useUrl();
  const { timezone } = useSettings();
  const f = useFilters();
  // Scope only, never time, so the track always shows the history being chosen from.
  const hourly = useHourly({ project: f.project, instance: f.instance, model: f.model });
  const zs = params.get('zs') ?? undefined;
  const ze = params.get('ze') ?? undefined;
  const dayTrack = params.get('track') === 'day';
  const minute = useMinute();
  const domain = useMemo(() => sliderDomain(hourly.data ?? [], f, { from: zs, to: ze, dayTrack }, timezone), [hourly.data, f.range, zs, ze, dayTrack, timezone, unitWindowKey(f), minute]); // eslint-disable-line react-hooks/exhaustive-deps
  const { slots, unit } = domain;
  const n = slots.length;

  const committed = useMemo(() => windowFromFilters(slots, f), [slots, f.since, f.until]); // eslint-disable-line react-hooks/exhaustive-deps
  // The gesture's states. idle: the window shown is the committed one. pressed: `grab` is set but not yet `armed` (a press
  // that has not moved). dragging: `held` carries the window under the pointer. typed: a key moved the window, which
  // commits after a short pause (`timer`). Releasing or the pause commits to the URL, which becomes `committed`.
  const [held, setHeld] = useState<{ window: SlotWindow; grip: Grip } | null>(null);
  const [typed, setTyped] = useState<SlotWindow | null>(null);
  const live = held?.window ?? typed ?? committed;

  const track = useRef<HTMLDivElement>(null);
  const grab = useRef<{ grip: Grip; offset: number; window: SlotWindow; x: number; armed: boolean } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const label = useMemo(() => formatter(unit, timezone), [unit, timezone]);
  const preview = (w: SlotWindow) => setWindowDraft(rangeFromWindow(domain, w));
  // A key press names its window exactly, so Home on a handle moves to the first bar and never turns into all history.
  const commit = (w: SlotWindow, exact = false) => {
    const range = rangeFromWindow(domain, w);
    if (exact && !range.since) range.since = new Date(slots[w[0]].start).toISOString();
    setWindowDraft(null);
    // A short preset's track is its own zoom, so dragging on it keeps looking at the same hours.
    const keep = (unit === 'hour' && !domain.zoomed) || domain.framed ? { zs: new Date(slots[0].start).toISOString(), ze: new Date(slots[n - 1].end).toISOString() } : {};
    // A window dragged on the day track stays on that track, however short it gets, until someone zooms.
    // A window dragged out to the whole track is a choice of everything, which is not the same as nothing chosen.
    set({ since: range.since, until: range.until, range: range.since || range.until ? null : 'all', rp: null, offset: null, track: unit === 'day' ? 'day' : null, ...keep });
  };
  useEffect(() => () => { window.clearTimeout(timer.current); setWindowDraft(null); }, []);
  // A preset or Clear pressed during the key pause must win over the window still waiting to commit.
  useEffect(() => {
    window.clearTimeout(timer.current);
    setTyped(null);
    setWindowDraft(null);
  }, [f.since, f.until, f.range]);

  const slotAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * n;
  };

  const down = (e: ReactPointerEvent<HTMLElement>, forced?: Grip) => {
    if (e.button !== 0 || !track.current) return;
    e.preventDefault();
    const at = slotAt(e.clientX);
    const [a, b] = live;
    const inside = at >= a && at <= b + 1;
    // A press on the bare track pulls the nearest handle to it. A press inside the band carries the whole window.
    const grip: Grip = forced ?? (inside ? 'both' : Math.abs(at - a) < Math.abs(at - (b + 1)) ? 'start' : 'end');
    // A handle or the band moves with the pointer at once. A press on the bare track only pulls a handle once it is dragged, so a stray click never stretches the window.
    grab.current = { grip, offset: grip === 'both' ? at - a : 0, window: live, x: e.clientX, armed: !!forced || grip === 'both' };
    e.currentTarget.setPointerCapture(e.pointerId);
    (e.currentTarget as HTMLElement).focus({ preventScroll: true });
    setHeld({ window: live, grip });
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const g = grab.current;
    if (!g) return;
    if (!g.armed) {
      if (Math.abs(e.clientX - g.x) < 4) return;
      g.armed = true;
    }
    const at = slotAt(e.clientX);
    if (g.window[0] === g.window[1]) {
      if (g.grip === 'end' && at < g.window[0]) g.grip = 'start';
      else if (g.grip === 'start' && at > g.window[1] + 1) g.grip = 'end';
    }
    const to = g.grip === 'both' ? Math.round(at - g.offset) : g.grip === 'start' ? Math.round(at) : Math.round(at) - 1;
    const next = moveWindow(g.window, g.grip, to, n);
    if (next[0] === g.window[0] && next[1] === g.window[1]) return;
    g.window = next;
    setHeld({ window: next, grip: g.grip });
    preview(next);
  };
  const up = () => {
    const g = grab.current;
    if (!g) return;
    grab.current = null;
    setHeld(null);
    if (g.window[0] !== committed[0] || g.window[1] !== committed[1]) commit(g.window);
    else setWindowDraft(null);
  };

  const onKey = (e: KeyboardEvent, which: 'start' | 'end') => {
    const page = unit === 'hour' ? 24 : 7;
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -page, PageUp: page };
    // Shift carries the whole window by one bar, keeping its exact length rather than rounding it to whole bars.
    if (e.shiftKey && f.since && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const by = (e.key === 'ArrowLeft' ? -1 : 1) * (slots[0].end - slots[0].start);
      const start = Date.parse(f.since);
      const end = f.range ? start + RANGES[f.range] : f.until ? Date.parse(f.until) + 1 : Date.now();
      const nextEnd = Math.min(end + by, Date.now());
      const open = nextEnd >= Date.now() - 60_000;
      set({ since: new Date(nextEnd - (end - start)).toISOString(), until: open ? null : new Date(nextEnd - 1).toISOString(), range: null, offset: null, ...((unit === 'hour' && !domain.zoomed) || domain.framed ? { zs: new Date(slots[0].start).toISOString(), ze: new Date(slots[n - 1].end).toISOString() } : {}) });
      return;
    }
    const grip = e.shiftKey ? 'both' : which;
    const cur = grip === 'end' ? live[1] : live[0];
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : steps[e.key] !== undefined ? cur + steps[e.key] : null;
    if (to === null) return;
    e.preventDefault();
    const next = moveWindow(live, grip, to, n);
    setTyped(next);
    preview(next);
    window.clearTimeout(timer.current);
    // Keys repeat quickly, so the query waits for a pause while the numbers that can follow already have.
    timer.current = window.setTimeout(() => { setTyped(null); commit(next, true); }, 320);
  };

  // Zoom only changes what the track shows. The window, and so the numbers, stay exactly as they are.
  const zoomIn = () => {
    const { from, to } = zoomRange(slots[live[0]].start, slots[live[1]].end);
    set({ zs: new Date(from).toISOString(), ze: new Date(to).toISOString(), track: null });
  };
  const canStep = !!f.since && !Number.isNaN(Date.parse(f.since)) && Date.parse(f.since) <= Date.now();
  const canStepForward = canStep && !!f.until;
  const stepBy = (direction: -1 | 1) => {
    if (!canStep || (direction === 1 && !canStepForward)) return;
    // A preset's own length, not the time since its rounded start, is what "the hour before" means.
    const next = stepWindow(Date.parse(f.since!), f.until ? Date.parse(f.until) + 1 : null, direction, Date.now(), f.range ? RANGES[f.range] : undefined);
    const origin = params.get('rp');
    if (direction === 1 && next.until === null && origin && Object.hasOwn(RANGES, origin)) {
      set({ range: origin, since: null, until: null, rp: null, zs: null, ze: null, track: null, offset: null });
      return;
    }
    set({ since: next.since, until: next.until, range: null, rp: f.range ?? origin, offset: null, track: null, ...(next.track ?? (domain.zoomed ? { zs: null, ze: null } : {})) });
  };
  const stepRef = useRef(stepBy);
  stepRef.current = stepBy;
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      // A list only reads letters, so the brackets still step from a focused one.
      const typing = isTypingTarget(e.target) && (e.target as HTMLElement).tagName !== 'SELECT';
      if (e.metaKey || e.ctrlKey || e.altKey || typing || document.querySelector('dialog[open]')) return;
      if (e.key === '[') { e.preventDefault(); stepRef.current(-1); }
      if (e.key === ']') { e.preventDefault(); stepRef.current(1); }
    };
    addEventListener('keydown', onKeyDown);
    return () => removeEventListener('keydown', onKeyDown);
  }, []);
  const zoomOut = () => set({ zs: null, ze: null, offset: null });

  const max = useMemo(() => Math.max(1, ...slots.map((d) => d.value)), [slots]);
  const bars = useMemo(() => {
    let d = '';
    slots.forEach((slot, i) => {
      if (!slot.value) return;
      const h = Math.max(1.5, Math.sqrt(slot.value / max) * 30);
      d += `M${i + 0.14} 30V${(30 - h).toFixed(2)}h0.72V30z`;
    });
    return d;
  }, [slots, max]);

  if (hourly.isPending) return <div className="ts ts-loading"><div className="skeleton ts-skeleton" role="status" aria-label="Loading time range" /></div>;
  if (hourly.isError) return <div className="ts ts-loading"><span className="fine">Time track unavailable. The presets still work.</span> <button type="button" className="link-btn" onClick={() => hourly.refetch()}>Retry</button></div>;
  if (n < 2) return null;

  const [a, b] = [Math.min(live[0], n - 1), Math.min(live[1], n - 1)];
  const count = b - a + 1;
  const whole = a === 0 && b === n - 1;
  const startText = label(slots[a].start);
  const endMark = unit === 'hour' ? slots[b].end : slots[b].start;
  // A preset's window is exact to the minute, so it is named rather than rounded to the bars it touches.
  const moved = !!held && (held.window[0] !== committed[0] || held.window[1] !== committed[1]);
  const preset = !moved && !typed && !!f.range;
  // A window opened by link or chart can be finer than the bars, so its own times are shown rather than rounded.
  const exactEnd = f.until ? Date.parse(f.until) + 1 : null;
  const exact = !moved && !typed && !f.range && !!f.since && (unit === 'hour' || Date.parse(f.since) !== slots[a].start || (exactEnd !== null && exactEnd !== slots[b].end));
  const exactLabel = (ms: number) => {
    // The year is only said when it is not this one, so a window in another year cannot pass for this year's.
    const year = new Date(ms).getUTCFullYear() === new Date().getUTCFullYear() ? {} : { year: 'numeric' as const };
    return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...year }).format(new Date(ms));
  };
  // A window that lies off the track has nothing on it to light.
  const offTrack = !!f.since && !held && !typed && (Date.parse(f.since) >= slots[n - 1].end || (exactEnd !== null && exactEnd <= slots[0].start));

  return (
    <div className="ts" data-holding={moved ? held!.grip : undefined} data-off-track={offTrack ? 'true' : undefined} style={{ '--a': `${startEdge(a, n)}%`, '--b': `${endEdge(b, n)}%` } as React.CSSProperties}>
      <div className="ts-read" aria-live="polite">
        <b>{preset ? `Last ${f.range}` : exact ? `${exactLabel(Date.parse(f.since!))} – ${exactEnd ? exactLabel(exactEnd) : 'now'}` : a === b && unit === 'day' ? startText : `${startText} – ${label(endMark)}`}</b>
        {!preset && !exact && <span>{unit === 'hour' && count >= 48 && count % 24 === 0 ? `${count / 24}d` : `${count}${unit === 'hour' ? 'h' : 'd'}`}</span>}
      </div>
      <div className="ts-zoom">
        <button type="button" className="icon-btn" disabled={!canStep} onClick={() => stepBy(-1)} aria-label="Step back one window" title={canStep ? 'The same length of time before ([)' : 'Pick a window to step through it'}><ChevronLeft size={15} aria-hidden="true" /></button>
        <button type="button" className="icon-btn" disabled={!canStepForward} onClick={() => stepBy(1)} aria-label="Step forward one window" title={canStepForward ? 'The same length of time after (])' : 'Already at the latest'}><ChevronRight size={15} aria-hidden="true" /></button>
        <button type="button" className="icon-btn" disabled={whole} onClick={zoomIn} aria-label="Zoom the track to this window" title={whole ? 'Pick a smaller window to zoom in' : 'Zoom in'}><ZoomIn size={15} aria-hidden="true" /></button>
        {(domain.zoomed || domain.framed) && <button type="button" className="icon-btn" onClick={domain.framed ? () => set({ track: 'day' }) : zoomOut} aria-label="Show the whole history on the track" title="Whole history on the track"><ZoomOut size={15} aria-hidden="true" /></button>}
      </div>
      <div className="ts-rail" ref={track} onPointerDown={(e) => down(e)} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <svg className="ts-bars" viewBox={`0 0 ${n} 30`} preserveAspectRatio="none" aria-hidden="true"><path d={bars} /></svg>
        <svg className="ts-bars ts-bars-on" viewBox={`0 0 ${n} 30`} preserveAspectRatio="none" aria-hidden="true"><path d={bars} /></svg>
        <span className="ts-line" aria-hidden="true" />
        {(['start', 'end'] as const).map((which) => {
          const text = which === 'start' ? startText : label(endMark);
          return (
            <span
              key={which}
              className={`ts-handle ts-${which}`}
              role="slider"
              tabIndex={0}
              aria-label={which === 'start' ? 'Window start' : 'Window end'}
              aria-valuemin={0}
              aria-valuemax={n - 1}
              aria-valuenow={which === 'start' ? a : b}
              aria-valuetext={text}
              onPointerDown={(e) => { e.stopPropagation(); down(e, which); }}
              onPointerMove={move}
              onPointerUp={up}
              onPointerCancel={up}
              onKeyDown={(e) => onKey(e, which)}
            >
              <i aria-hidden="true" />
              <em aria-hidden="true">{text}</em>
            </span>
          );
        })}
      </div>
    </div>
  );
}

const unitWindowKey = (f: { since?: string; until?: string; range?: string }) => (f.range ? '' : `${f.since ?? ''}|${f.until ?? ''}`);

function formatter(unit: SlotUnit, tz: string) {
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short' });
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return (ms: number) => (unit === 'hour' ? hour : day).format(new Date(ms));
}

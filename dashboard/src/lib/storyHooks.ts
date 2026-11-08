import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { prefersStill } from '../components/motion';
import { getEntities, scanPages, type ScanResult } from './api';
import { BIG_PAGE } from './data';
import { toAgent } from './entities';
import type { Entity } from './types';

export const STORY_EVENT_MAX = 20_000;

/**
 * Every event recorded against one thread, newest first as the API sends them, with previews instead of full content.
 * The whole thread is read up to a bound, and the result says whether anything older was left unread.
 */
export function useThreadEvents(id: string) {
  const [progress, setProgress] = useState(0);
  const query = useQuery<ScanResult<Entity>>({
    queryKey: ['story-events', id],
    queryFn: ({ signal }) => scanPages<Entity, Entity>('timeline', new URLSearchParams({ id, include_content: 'false' }), (e) => e, STORY_EVENT_MAX, signal, BIG_PAGE, setProgress),
  });
  return { ...query, progress };
}

/** The full task and result text of one agent record, read on demand because list rows carry a preview only. */
export function useFullAgent(sourceId: string | null) {
  return useQuery({
    queryKey: ['agent-full', sourceId],
    enabled: !!sourceId,
    queryFn: async ({ signal }) => {
      const rows = await getEntities<Entity>('agents', new URLSearchParams({ id: sourceId!, limit: '1', include_content: 'true' }), signal);
      const row = rows.find((r) => r.source_id === sourceId);
      return row ? toAgent(row) : null;
    },
  });
}

/** The newest page of a sub-agent's own thread, enough to say what it did. Read only when that lane is selected. */
export function useChildEvents(threadId: string | null) {
  return useQuery({
    queryKey: ['story-child', threadId],
    enabled: !!threadId,
    queryFn: ({ signal }) => getEntities<Entity>('timeline', new URLSearchParams({ id: threadId!, limit: '500', include_content: 'false' }), signal),
  });
}

export function useWidth<T extends HTMLElement>(ref: RefObject<T | null>, fallback = 720) {
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(([entry]) => { const w = entry.contentRect.width; if (w > 0) setWidth(w); });
    ro.observe(el);
    setWidth(el.clientWidth || fallback);
    return () => ro.disconnect();
  }, [ref, fallback]);
  return width;
}

export type Pace = 'quick' | 'normal' | 'slow';
/** How long the whole compressed story takes to play, in milliseconds. */
export const PACE_MS: Record<Pace, number> = { quick: 12_000, normal: 30_000, slow: 90_000 };

export interface Player {
  playing: boolean;
  pace: Pace;
  /** Current position, 0–1, as React state sampled a few times a second. The exact value is in `progressRef`. */
  progress: number;
  progressRef: RefObject<number>;
  /** Subscribe to every frame. Used to move the clip and the playhead without re-rendering React. */
  onFrame: (fn: (progress: number) => void) => () => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  restart: () => void;
  seek: (progress: number, opts?: { keepPlaying?: boolean }) => void;
  setPace: (p: Pace) => void;
}

/**
 * A transport for the story. Progress runs 0–1 on requestAnimationFrame; frame listeners get every value, React gets a
 * sample about twelve times a second. Reduced motion starts at the end and never plays by itself.
 * States: playing; paused (not playing, progress below 1); ended (not playing, progress 1). `progressRef` is the source of
 * truth and `progress` its sampled copy for rendering.
 */
export function usePlayer(opts: { initial: number | null; autoplay: boolean; onPause?: (progress: number) => void }): Player {
  const still = prefersStill();
  const progressRef = useRef(opts.initial ?? (still ? 1 : 0));
  const [progress, setProgress] = useState(progressRef.current);
  const [playing, setPlaying] = useState(opts.autoplay && !still && (opts.initial ?? 0) < 1);
  const [pace, setPace] = useState<Pace>('normal');
  const listeners = useRef(new Set<(p: number) => void>());
  const lastSample = useRef(0);
  const onPause = opts.onPause;

  const emit = useCallback((p: number, force = false) => {
    progressRef.current = p;
    listeners.current.forEach((fn) => fn(p));
    const now = performance.now();
    if (force || now - lastSample.current > 80) { lastSample.current = now; setProgress(p); }
  }, []);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      const next = Math.min(1, progressRef.current + dt / PACE_MS[pace]);
      emit(next, next >= 1);
      if (next >= 1) { setPlaying(false); onPause?.(1); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, pace, emit, onPause]);

  const onFrame = useCallback((fn: (p: number) => void) => { listeners.current.add(fn); fn(progressRef.current); return () => { listeners.current.delete(fn); }; }, []);
  const play = useCallback(() => { if (progressRef.current >= 1) emit(0, true); setPlaying(true); }, [emit]);
  const pause = useCallback(() => { setPlaying(false); onPause?.(progressRef.current); }, [onPause]);
  const toggle = useCallback(() => { if (playing) pause(); else play(); }, [playing, play, pause]);
  const restart = useCallback(() => { emit(0, true); setPlaying(!still); }, [emit, still]);
  const seek = useCallback((p: number, o?: { keepPlaying?: boolean }) => {
    emit(Math.min(1, Math.max(0, p)), true);
    if (!o?.keepPlaying) { setPlaying(false); onPause?.(progressRef.current); }
  }, [emit, onPause]);

  return useMemo(() => ({ playing, pace, progress, progressRef, onFrame, play, pause, toggle, restart, seek, setPace }), [playing, pace, progress, onFrame, play, pause, toggle, restart, seek]);
}

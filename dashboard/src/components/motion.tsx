import { useEffect, useRef, useState } from 'react';
import { fmtCompact } from '../lib/format';

export const prefersStill = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Eases a number toward its target. The first value counts up from zero; reduced motion gets the final value at once. */
export function useTween(target: number, ms = 900) {
  const [shown, setShown] = useState(() => (prefersStill() ? target : 0));
  const from = useRef(shown);
  useEffect(() => {
    if (prefersStill() || typeof requestAnimationFrame !== 'function') { from.current = target; setShown(target); return; }
    const start = from.current;
    let raf = 0;
    let t0 = 0;
    const step = (now: number) => {
      t0 ||= now;
      const p = Math.min(1, (now - t0) / ms);
      const v = p === 1 ? target : start + (target - start) * (1 - (1 - p) ** 4);
      from.current = v;
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return shown;
}

/** A number that glides to its value. Its exact value belongs in the surrounding `title`. */
export function Counter({ value, format = fmtCompact, ms }: { value: number; format?: (n: number) => string; ms?: number }) {
  return <>{format(useTween(value, ms))}</>;
}

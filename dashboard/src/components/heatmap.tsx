import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Heatmap as HeatmapData } from '../lib/analytics';
import { fmtInt } from '../lib/format';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Native table with roving arrow-key focus and a live readout, so it works without hovering. */
export function ActivityHeatmap({ data }: { data: HeatmapData }) {
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const root = useRef<HTMLTableElement>(null);
  // Square root keeps quiet hours visible beside one very busy hour; the readout always gives the exact count.
  const level = (v: number) => (v === 0 || data.max === 0 ? 0 : Math.min(5, Math.ceil(Math.sqrt(v / data.max) * 5)));
  const entry = useMemo(() => {
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) if (data.grid[d][h] === data.max) return [d, h] as [number, number];
    return [0, 0] as [number, number];
  }, [data]);
  const focus = cursor ?? entry;

  const onKey = (e: KeyboardEvent) => {
    const [d, h] = focus;
    const next: Record<string, [number, number]> = {
      ArrowUp: [Math.max(0, d - 1), h], ArrowDown: [Math.min(6, d + 1), h],
      ArrowLeft: [d, Math.max(0, h - 1)], ArrowRight: [d, Math.min(23, h + 1)],
      Home: [d, 0], End: [d, 23],
    };
    const n = next[e.key];
    if (!n) return;
    e.preventDefault();
    setCursor(n);
    root.current?.querySelector<HTMLElement>(`[data-cell="${n[0]}-${n[1]}"]`)?.focus();
  };
  const read = ([d, h]: [number, number]) => `${DAYS[d]} ${String(h).padStart(2, '0')}:00 · ${fmtInt(data.grid[d][h])} prompts`;
  const readout = cursor ? read(cursor) : data.max ? `Peak ${read(entry)}` : 'No prompts in this window';

  return (
    <div className="heatmap">
      <div className="table-scroll heatmap-scroll">
        <table ref={root} role="grid" aria-label="Prompts by weekday and hour of day" onKeyDown={onKey} onMouseLeave={() => setCursor(null)}>
          <thead>
            <tr>
              <td aria-hidden="true" />
              {Array.from({ length: 24 }, (_, h) => <th key={h} scope="col">{h % 3 === 0 ? String(h).padStart(2, '0') : <span className="sr-only">{h}:00</span>}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.grid.map((row, d) => (
              <tr key={DAYS[d]}>
                <th scope="row">{DAYS[d]}</th>
                {row.map((v, h) => (
                  <td
                    key={h}
                    data-cell={`${d}-${h}`}
                    data-level={level(v)}
                    style={{ '--d': d, '--h': h } as React.CSSProperties}
                    tabIndex={focus[0] === d && focus[1] === h ? 0 : -1}
                    onMouseEnter={() => setCursor([d, h])}
                    onFocus={() => setCursor([d, h])}
                    aria-label={`${DAYS[d]} ${h}:00, ${v} prompts`}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="heatmap-foot">
        <span className="fine" aria-live="polite">{readout}</span>
        <span className="heatmap-scale" aria-label={`Scale from 0 to ${fmtInt(data.max)} prompts per cell`}>
          0
          {[0, 1, 2, 3, 4, 5].map((l) => <i key={l} data-level={l} />)}
          {fmtInt(data.max)}
        </span>
      </div>
    </div>
  );
}

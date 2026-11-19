import { useQuery } from '@tanstack/react-query';
import { getJson } from '../lib/api';
import { apiParams, type Filters } from '../lib/filters';
import { fmtInt } from '../lib/format';
import type { EfficiencyRow, Envelope } from '../lib/types';
import { Async, Panel, SkeletonRows, Stat, StatRow, Unknown } from './ui';

/** Whole-scope ratios from the service, never calculated from a paged list. */
export function Efficiency({ filters }: { filters: Filters }) {
  const params = apiParams('usage/efficiency', filters);
  const query = useQuery({
    queryKey: ['usage/efficiency', params.toString()],
    refetchInterval: filters.until ? false : 60_000,
    queryFn: async ({ signal }) => (await getJson<Envelope<EfficiencyRow>>('usage/efficiency', params, signal)).data[0],
  });
  return <Panel title="Observed efficiency" sub="Captured work only. These ratios do not measure answer quality.">
    <Async query={query} skeleton={<SkeletonRows rows={2} label="Loading efficiency" />} compact>
      {(r) => <>
        <StatRow label="Efficiency measures">
          <Stat label="Tool calls per provider turn" value={r.tools_per_turn === null ? <Unknown why="No provider turns have usable run links in this window." /> : r.tools_per_turn.toFixed(2)}
            sub={<>{fmtInt(r.linked_tools)} of {fmtInt(r.tools)} calls · {fmtInt(r.linked_turns)} of {fmtInt(r.provider_turns)} turns linked</>} />
          <Stat label="Retries per thread" value={r.retries_per_thread === null ? <Unknown why="No thread has a complete recorded attempt sequence for every run requested in this window." /> : r.retries_per_thread.toFixed(2)}
            sub={<>{fmtInt(r.covered_threads)} of {fmtInt(r.threads)} threads covered · {fmtInt(r.covered_runs)} of {fmtInt(r.runs)} runs</>} />
        </StatRow>
        <p className="fine">Tool calls and provider turns are joined by machine and run within this window. Historical capture is partial; provider turns are not individual model calls.</p>
        <p className="fine">Retries count extra recorded run attempts for runs requested in this window, including steering restarts. {r.reattempts !== null && <>{fmtInt(r.reattempts)} extra attempts in covered threads; {fmtInt(r.steering_restarts ?? 0)} were steering restarts. </>}Provider-internal retries are not captured. Missing or duplicate attempt ordinals exclude a thread from this average.</p>
      </>}
    </Async>
  </Panel>;
}

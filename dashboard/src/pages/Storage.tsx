import { useMemo } from 'react';
import { Command, ErrorState, NotLoaded, PageHeader, Panel, RankedBars, Skeleton, Stat, StatRow, Unknown } from '../components/ui';
import { useLatestRecord, useOverview, useStorage } from '../lib/data';
import { fmtBytes, fmtCompact, fmtDateTime, fmtInt, isKnown } from '../lib/format';
import { useSettings } from '../lib/settings';

const LABEL: Record<string, string> = { tool: 'Tool calls', answer: 'Answers', prompt: 'Prompts', run: 'Runs', model_turn: 'Provider turns', thread: 'Threads', agent: 'Sub-agents', project: 'Projects', instance: 'Instances', external_request: 'External requests' };
const SIZE_WHY = 'The API does not report this yet. Run the command below for local numbers.';

export default function Storage() {
  const { timezone } = useSettings();
  const storage = useStorage();
  const counts = useOverview({});
  const latest = useLatestRecord();

  // Record counts stay available from the overview when the heavier storage query fails.
  const rows = useMemo(() => {
    const fromStorage = storage.data?.rows;
    const list = fromStorage ?? Object.entries(counts.data ?? {}).map(([table, n]) => ({ table, rows: n }));
    return [...list].sort((a, b) => b.rows - a.rows);
  }, [storage.data, counts.data]);
  const records = rows.reduce((s, r) => s + r.rows, 0);
  // With both queries failed nothing is known about the records, which is not the same as having none.
  const countsKnown = !!storage.data || !!counts.data;
  const countsFailed = !countsKnown && storage.isError && counts.isError;
  const s = storage.data;
  const events = s?.events;
  const redacted = s?.redacted_content_characters;
  const normalized = s?.normalized_json_characters;

  return (
    <>
      <PageHeader title="Storage" lead="The analytics database, not your T3 data." />
      {storage.isError && (
        <Panel>
          <ErrorState compact error={storage.error} onRetry={() => storage.refetch()} />
          <p className="fine">{countsFailed ? 'Sizes and record counts are unavailable until the service answers.' : 'Sizes are unavailable until this query succeeds. Record counts below come from a lighter query.'}</p>
        </Panel>
      )}
      {storage.isPending ? <Skeleton height="6rem" label="Loading storage" /> : (
        <StatRow label="Storage summary">
          <Stat label="Current records" value={countsFailed ? <NotLoaded /> : countsKnown ? fmtInt(records) : '…'} sub={countsKnown ? `${fmtInt(rows.length)} record kinds` : undefined} />
          <Stat label="Event revisions" value={isKnown(events) ? fmtInt(events) : <Unknown label="Unknown" why={SIZE_WHY} />} sub={isKnown(events) && records ? `${(events / records).toFixed(2)} per record` : undefined} />
          <Stat label="Database size" value={isKnown(s?.duckdb_bytes) ? fmtBytes(s.duckdb_bytes) : <Unknown why={SIZE_WHY} />} sub={s?.capture_source ? `Source ${s.capture_source}` : undefined} />
          <Stat label="Redacted text" value={isKnown(redacted) ? `${fmtCompact(redacted)} chars` : <Unknown why={SIZE_WHY} />} sub={isKnown(normalized) ? `${fmtCompact(normalized)} chars of normalized JSON` : undefined} />
        </StatRow>
      )}
      <div className="split">
        <Panel className="grow-2" title="Records by kind" sub="Current row per entity">
          {rows.length ? <RankedBars label="Records by kind" total={records} items={rows.map((r) => ({ key: r.table, label: LABEL[r.table] ?? r.table, value: r.rows }))} />
            : countsFailed ? <ErrorState compact error={counts.error} onRetry={() => { storage.refetch(); counts.refetch(); }} />
              : countsKnown ? <p className="fine">No records yet.</p> : <Skeleton height="12rem" label="Loading records" />}
        </Panel>
        <Panel className="grow-1" title="Freshness and span">
          <dl className="facts">
            <div><dt>Oldest record</dt><dd>{s?.oldest_at ? fmtDateTime(s.oldest_at, timezone) : <Unknown label="Unknown" why={SIZE_WHY} />}</dd></div>
            <div><dt>Newest record</dt><dd>{s?.newest_at || latest.data ? fmtDateTime(s?.newest_at ?? latest.data?.occurred_at, timezone) : latest.isPending ? '…' : <Unknown label="Unknown" />}</dd></div>
            <div><dt>Latest write</dt><dd>{latest.data?.captured_at ? fmtDateTime(latest.data.captured_at, timezone) : latest.isPending ? '…' : <Unknown label="Unknown" />}</dd></div>
            <div><dt>Source version</dt><dd className="mono">{latest.data?.source_version ?? 'Unknown'}</dd></div>
            <div><dt>Archive size</dt><dd>{isKnown(s?.archive_bytes) ? fmtBytes(s.archive_bytes) : <Unknown why={SIZE_WHY} />}</dd></div>
          </dl>
        </Panel>
      </div>
      <Panel title="Maintenance" sub="These run from the local CLI. Stop the service first, because DuckDB allows one writer process.">
        <div className="command-grid">
          <div><h3>Inspect</h3><Command text="runtrace storage stats" /></div>
          <div><h3>Back up events</h3><Command text="runtrace archive run" /></div>
          <div><h3>Verify backups</h3><Command text="runtrace archive verify" /></div>
          <div><h3>Apply content retention</h3><Command text="runtrace retention run" /></div>
        </div>
        <p className="fine">Purges are logical deletes. Old database pages and existing backups must be removed separately.</p>
      </Panel>
    </>
  );
}

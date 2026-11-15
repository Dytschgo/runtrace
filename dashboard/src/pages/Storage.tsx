import { useMemo } from 'react';
import { Bot, Coins, Database, Folder, Globe, MessageSquare, MessageSquareReply, MessagesSquare, Play, Server, Wrench, type LucideIcon } from 'lucide-react';
import { Command, ErrorState, NotLoaded, PageHeader, Panel, RankedBars, Skeleton, Stat, StatRow, Unknown } from '../components/ui';
import { useLatestRecord, useOverview, useStorage } from '../lib/data';
import { fmtBytes, fmtCompact, fmtDateTime, fmtDay, fmtInt, isKnown } from '../lib/format';
import { useUrl, type PageName } from '../lib/url';
import { useSettings } from '../lib/settings';

const ICON: Record<string, LucideIcon> = { tool: Wrench, answer: MessageSquareReply, prompt: MessageSquare, run: Play, model_turn: Coins, thread: MessagesSquare, agent: Bot, project: Folder, instance: Server, external_request: Globe };
const PAGE_OF: Record<string, PageName> = { tool: 'Tool Calls', answer: 'Activity', prompt: 'Activity', run: 'Activity', model_turn: 'Models', thread: 'Threads', agent: 'Agent Trees', project: 'Projects', instance: 'Settings' };
const LABEL: Record<string, string> = { tool: 'Tool calls', answer: 'Answers', prompt: 'Prompts', run: 'Runs', model_turn: 'Provider turns', thread: 'Threads', agent: 'Sub-agents', project: 'Projects', instance: 'Instances', external_request: 'External requests' };
const SIZE_WHY = 'The API does not report this yet. Run the command below for local numbers.';
/** A size from the storage query: not loaded when that query failed, unknown when it answered without it. */
const size = (failed: boolean, label?: string) => (failed ? <NotLoaded /> : <Unknown label={label} why={SIZE_WHY} />);

export default function Storage() {
  const { hrefPage } = useUrl();
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
      <PageHeader title="Storage" lead={countsKnown && isKnown(s?.duckdb_bytes) ? <>{fmtInt(records)} records in {fmtBytes(s.duckdb_bytes)}. This is Runtrace's own database, not your T3 data.</> : "Runtrace's own database, not your T3 data."} />
      {storage.isError && (
        <Panel>
          <ErrorState compact error={storage.error} onRetry={() => storage.refetch()} />
          <p className="fine">{countsFailed ? 'Sizes and record counts are unavailable until the service answers.' : 'Sizes are unavailable until this query succeeds. Record counts below come from a lighter query.'}</p>
        </Panel>
      )}
      {storage.isPending ? <Skeleton height="6rem" label="Loading storage" /> : (
        <StatRow label="Storage summary">
          <Stat label="Current records" value={countsFailed ? <NotLoaded /> : countsKnown ? fmtInt(records) : '…'} sub={countsKnown ? `${fmtInt(rows.length)} record kinds` : undefined} />
          <Stat label="History" value={s?.oldest_at && s?.newest_at ? `${fmtInt(Math.max(1, Math.round((Date.parse(s.newest_at) - Date.parse(s.oldest_at)) / 86_400_000)))} days` : size(storage.isError, 'Unknown')} sub={s?.oldest_at ? `since ${fmtDay(s.oldest_at, timezone)}` : undefined} />
          <Stat label="Database size" value={isKnown(s?.duckdb_bytes) ? fmtBytes(s.duckdb_bytes) : size(storage.isError)} sub={s?.capture_source ? `Source ${s.capture_source}` : undefined} />
          <Stat label="Redacted text" value={isKnown(redacted) ? `${fmtCompact(redacted)} chars` : size(storage.isError)} sub={isKnown(normalized) && isKnown(redacted) && normalized ? `about ${Math.round((redacted / normalized) * 100)}% of the ${fmtCompact(normalized)} chars stored` : undefined} />
        </StatRow>
      )}
      <div className="split">
        <Panel className="grow-2" title="Records by kind">
          {rows.length ? <RankedBars label="Records by kind" total={records} byShare items={rows.map((r) => { const Icon = ICON[r.table] ?? Database; return { key: r.table, label: <span className="kind-label"><Icon size={13} aria-hidden="true" />{LABEL[r.table] ?? r.table}</span>, value: r.rows, href: PAGE_OF[r.table] ? hrefPage(PAGE_OF[r.table], ['prompt', 'answer', 'run'].includes(r.table) ? { kind: r.table } : {}) : undefined }; })} />
            : countsFailed ? <ErrorState compact error={counts.error} onRetry={() => { storage.refetch(); counts.refetch(); }} />
              : countsKnown ? <p className="fine">No records yet.</p> : <Skeleton height="12rem" label="Loading records" />}
        </Panel>
        <Panel className="grow-1" title="Freshness and span">
          <dl className="facts">
            <div><dt>Oldest record</dt><dd>{s?.oldest_at ? <>{fmtDateTime(s.oldest_at, timezone)}</> : size(storage.isError, 'Unknown')}</dd></div>
            <div><dt>Newest record</dt><dd>{s?.newest_at || latest.data ? fmtDateTime(s?.newest_at ?? latest.data?.occurred_at, timezone) : latest.isPending ? '…' : <Unknown label="Unknown" />}</dd></div>
            <div><dt>Latest write</dt><dd>{latest.data?.captured_at ? fmtDateTime(latest.data.captured_at, timezone) : latest.isPending ? '…' : <Unknown label="Unknown" />}</dd></div>
            <div><dt>Source version</dt><dd className="mono">{latest.data?.source_version ?? 'Unknown'}</dd></div>
            <div><dt>Archive size</dt><dd>{isKnown(s?.archive_bytes) ? fmtBytes(s.archive_bytes) : size(storage.isError)}</dd></div>
          </dl>
        </Panel>
      </div>
      <Panel title="Maintenance" hint="These run from the local CLI. Stop the service first, because DuckDB allows one writer process.">
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

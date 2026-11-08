import { useMemo } from 'react';
import { Async, CoverageBar, ErrorState, NoRecords, NotLoaded, PageHeader, Panel, QualityBadge, RankedBars, Skeleton, SkeletonRows, Stat, StatRow, Tokens, Unknown } from '../components/ui';
import { coverageRows, usageByProvider } from '../lib/analytics';
import { useAgents, useCollectorReadiness, useFieldReport, useModels, useModelTurns, useQuality, useQualityReport, useQuota, useThreads } from '../lib/data';
import { fmtInt, fmtPct, isKnown } from '../lib/format';

const QUALITIES = ['complete', 'partial', 'inferred', 'unavailable'];
const KIND_LABEL: Record<string, string> = { tool: 'Tool calls', answer: 'Answers', prompt: 'Prompts', run: 'Runs', model_turn: 'Provider turns', thread: 'Threads', agent: 'Sub-agents', project: 'Projects', instance: 'Instances', external_request: 'External requests' };

const GAPS: [string, string][] = [
  ['Model calls', 'Tokens are reported per provider turn, and one turn can contain several model calls. Calls stay null and turns are never counted as calls.'],
  ['Cost', 'Pricing is not captured, so no cost is derived from tokens.'],
  ['Historical quota', 'No snapshots were found. Past unused capacity cannot be reconstructed.'],
  ['Older messages', 'Migrated messages with no provably terminal run are excluded and counted in completed import-quality reports.'],
  ['Streaming content', 'Active message chunks are deliberately not stored.'],
  ['Clock offset', 'Source timestamps are retained. Remote clock offset has not been measured.'],
];

export default function DataQuality() {
  const quality = useQuality();
  const report = useQualityReport();
  const readiness = useCollectorReadiness();
  const threads = useThreads({});
  const agents = useAgents({});
  // Counted by the service over every tool call, so the coverage is never a sample.
  const fields = useFieldReport();
  const turns = useModelTurns({});
  const models = useModels({});
  const quota = useQuota('quota/current');

  const matrix = useMemo(() => {
    const kinds = [...new Set((quality.data ?? []).map((r) => r.kind))];
    const qs = [...new Set([...QUALITIES, ...(quality.data ?? []).map((r) => r.capture_quality)])];
    const grid = kinds.map((k) => {
      const cells = Object.fromEntries(qs.map((q) => [q, quality.data?.find((r) => r.kind === k && r.capture_quality === q)?.count ?? 0]));
      return { kind: k, cells, total: Object.values(cells).reduce((a, b) => a + b, 0) };
    }).sort((a, b) => b.total - a.total);
    return { qs, grid };
  }, [quality.data]);

  const total = matrix.grid.reduce((s, r) => s + r.total, 0);
  const complete = matrix.grid.reduce((s, r) => s + (r.cells.complete ?? 0), 0);
  const partial = matrix.grid.reduce((s, r) => s + (r.cells.partial ?? 0), 0);

  const turnRows = turns.data?.rows ?? (turns.isError ? [] : undefined);
  const toolFields = fields.data?.tools;
  const coverage = useMemo(() => (threads.data && agents.data && toolFields && turnRows ? coverageRows(threads.data.rows, agents.data.rows, toolFields, turnRows) : null), [threads.data, agents.data, toolFields, turnRows]);
  const redactions = fields.data?.redactions ?? [];
  const providers = useMemo(() => usageByProvider(turns.data?.rows ?? []), [turns.data]);
  const measured = coverage?.filter((c) => c.total > 0) ?? [];
  const coverageFailed = !coverage && !!(threads.error ?? agents.error ?? fields.error ?? turns.error);
  const full = measured.filter((c) => c.known === c.total).length;
  const none = measured.filter((c) => c.known === 0).length;
  const callsKnown = (models.data ?? []).filter((m) => isKnown(m.calls)).length;
  const checkpoints = report.data?.checkpoints;
  const projectCheckpoints = report.data?.project_checkpoints;
  const importErrors = report.data?.import_reports?.flatMap((r) => r.project_errors ?? []) ?? [];

  return (
    <>
      <PageHeader title="Data Quality" lead="What each number can support." />

      {checkpoints !== undefined && (
        <Panel title="Collection coverage" sub="Source freshness is separate from whether the service is reachable.">
          {!checkpoints.length && <p role="status">No complete instance sync has finished. Backfill may still be running; totals describe the records imported so far.</p>}
          <dl className="facts facts-wide">
            <div><dt>Collector</dt><dd>{readiness.data?.collector?.state === 'starting' ? 'Ingesting retained history' : readiness.data?.collector?.state ?? <Unknown label="Unavailable" />}</dd></div>
            <div><dt>Project checkpoints</dt><dd>{projectCheckpoints ? fmtInt(projectCheckpoints.length) : <Unknown label="Unavailable" />}</dd></div>
            <div><dt>Missing thread relationships</dt><dd>{report.data?.missing_thread_relationships === undefined ? <Unknown label="Unavailable" /> : fmtInt(report.data.missing_thread_relationships)}</dd></div>
            <div><dt>Latest import reports</dt><dd>{report.data?.import_reports?.length ? fmtInt(report.data.import_reports.length) : 'No completed report yet'}</dd></div>
          </dl>
          {(report.data?.sync_progress ?? []).map((p, i) => <p key={i} role="status">{p.project_id ? <>Latest import progress: project {p.project_position ?? '?'} of {p.projects_discovered ?? '?'}: <code>{p.project_id}</code>. {p.committed_changes_in_project === undefined ? <Unknown label="Unavailable" /> : fmtInt(p.committed_changes_in_project)} committed changes in this project.</> : <>{p.projects_completed_this_pass ?? '?'} of {p.projects_discovered ?? '?'} projects completed in the latest pass ({p.state ?? 'status unavailable'}).</>}</p>)}
          {importErrors.length > 0 && <ul>{importErrors.map((e, i) => <li key={`${e.project_id}:${i}`}><code>{e.project_id}</code>: {e.error_category}</li>)}</ul>}
          {checkpoints.length > 0 && <div className="table-scroll" tabIndex={0} role="region" aria-label="Instance checkpoints"><table><thead><tr><th scope="col">Instance</th><th scope="col">Source watermark</th><th scope="col">Last successful sync</th></tr></thead><tbody>{checkpoints.map((c) => <tr key={c.instance_id}><th scope="row">{c.instance_id}</th><td><time>{c.source_updated_at}</time></td><td><time>{c.last_successful_sync_at}</time></td></tr>)}</tbody></table></div>}
        </Panel>
      )}

      <StatRow label="Quality summary">
        <Stat label="Records" value={quality.isError ? <NotLoaded /> : quality.isPending ? '…' : fmtInt(total)} sub="Across all kinds" />
        <Stat label="Marked complete" value={quality.isError ? <NotLoaded /> : quality.isPending ? '…' : fmtPct(total ? complete / total : 0)} sub={quality.data ? `${fmtInt(partial)} marked partial` : undefined} />
        <Stat label="Fields fully known" value={coverageFailed ? <NotLoaded /> : coverage ? `${fmtInt(full)} of ${fmtInt(measured.length)}` : '…'} sub={coverage ? `${fmtInt(none)} never captured` : undefined} />
        <Stat label="Quota status" value={quota.data?.data?.length ? 'Sampling' : quota.isPending ? '…' : <Unknown label="Unavailable" why={quota.data?.reason} />} sub={quota.data?.window_status === 'historical_without_snapshots' ? 'History without snapshots' : undefined} />
      </StatRow>

      <div className="split">
        <Panel className="grow-2" title="Token usage by provider" sub="Whether each provider reported usage for its turns. Measured from provider turns, not assumed." flush>
          {turns.isPending ? <div className="pad"><SkeletonRows rows={4} label="Loading provider usage" /></div>
            : turns.isError ? <div className="pad"><ErrorState error={turns.error} onRetry={() => turns.refetch()} compact /></div>
              : !providers.length ? <div className="pad"><p className="fine">No provider turns recorded. This service may predate them.</p></div>
                : (
                  <div className="table-scroll" tabIndex={0} role="region" aria-label="Token usage by provider">
                    <table className="sticky-first">
                      <thead><tr><th scope="col">Provider</th><th scope="col" className="num">Turns</th><th scope="col">Reported</th><th scope="col" className="num">Complete</th><th scope="col" className="num">Partial</th><th scope="col" className="num">None</th><th scope="col" className="num">Tokens</th></tr></thead>
                      <tbody>
                        {providers.map((p) => (
                          <tr key={p.provider}>
                            <th scope="row" className="mono">{p.provider}</th>
                            <td className="num">{fmtInt(p.turns)}</td>
                            <td><span className="usage-cell"><CoverageBar known={p.complete + p.partial} total={p.turns} label={`${p.provider}, turns reporting usage`} /></span></td>
                            <td className="num">{fmtInt(p.complete)}</td>
                            <td className="num">{fmtInt(p.partial)}</td>
                            <td className="num">{p.unavailable ? fmtInt(p.unavailable) : <span className="fine">0</span>}</td>
                            <td className="num"><Tokens v={p.total} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
          {turns.data && !turns.data.complete && <p className="fine pad">Based on the latest {fmtInt(turns.data.scanned)} provider turns.</p>}
        </Panel>
        <Panel className="grow-1" title="Redactions" sub="Tool call and sub-agent records with a removed match">
          {fields.isPending ? <SkeletonRows rows={4} label="Loading redactions" />
            : fields.isError ? <ErrorState error={fields.error} onRetry={() => fields.refetch()} compact />
            : redactions.length ? <RankedBars label="Records by redaction category" items={redactions.map((r) => ({ key: r.category, label: <span className="mono">{r.category}</span>, value: r.records }))} />
              : <p className="fine">No redactions in these records.</p>}
        </Panel>
      </div>

      <Panel
        title="Field coverage"
        sub="Solid is the share of records where the field holds a value. Hatched is missing, which is not the same as zero."
      >
        {threads.error ?? agents.error ?? fields.error ? <ErrorState error={threads.error ?? agents.error ?? fields.error} onRetry={() => { threads.refetch(); agents.refetch(); fields.refetch(); }} compact />
          : !coverage ? <SkeletonRows rows={10} label="Measuring coverage" />
            : (
              <ul className="coverage-list">
                {coverage.map((c) => (
                  <li key={c.id}>
                    <div className="coverage-head">
                      <span className="coverage-name"><small>{c.entity}</small>{c.field}</span>
                      <span className="coverage-count">{c.total ? <>{fmtPct(c.known / c.total)} <small>{fmtInt(c.known)} of {fmtInt(c.total)}</small></> : <small>No records</small>}</span>
                    </div>
                    <CoverageBar known={c.known} total={c.total} label={`${c.entity}, ${c.field}`} />
                    <p>{c.note}</p>
                  </li>
                ))}
                <li>
                  <div className="coverage-head">
                    <span className="coverage-name"><small>Models</small>Model calls</span>
                    <span className="coverage-count">{models.data?.length ? <>{fmtPct(callsKnown / models.data.length)} <small>{fmtInt(callsKnown)} of {fmtInt(models.data.length)}</small></> : <small>No records</small>}</span>
                  </div>
                  <CoverageBar known={callsKnown} total={models.data?.length ?? 0} label="Models with a model call count" />
                  <p>One provider turn can contain several calls, so turns are never substituted for this.</p>
                </li>
              </ul>
            )}
      </Panel>

      <Panel title="Capture quality by kind" sub="The label stored on each record. Current sources are conservatively partial." flush>
        <Async query={quality} skeleton={<div className="pad"><Skeleton height="12rem" label="Loading quality" /></div>} isEmpty={(d) => !d.length} empty={<NoRecords />}>
          {() => (
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Capture quality by kind">
              <table className="sticky-first">
                <thead><tr><th scope="col">Kind</th>{matrix.qs.map((q) => <th key={q} scope="col" className="num"><QualityBadge quality={q} /></th>)}<th scope="col" className="num">Total</th></tr></thead>
                <tbody>
                  {matrix.grid.map((r) => (
                    <tr key={r.kind}>
                      <th scope="row">{KIND_LABEL[r.kind] ?? r.kind}</th>
                      {matrix.qs.map((q) => <td key={q} className="num">{r.cells[q] ? fmtInt(r.cells[q]) : <span className="fine">0</span>}</td>)}
                      <td className="num">{fmtInt(r.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Async>
      </Panel>

      <Panel title="Known gaps" sub="Limits of the current release. These constrain every chart.">
        <dl className="facts facts-wide">
          {GAPS.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
      </Panel>
    </>
  );
}

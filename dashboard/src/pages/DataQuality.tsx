import { useUrl } from '../lib/url';
import { useMemo, useState } from 'react';
import { CheckCircle2, CircleDashed, CircleSlash } from 'lucide-react';
import { AppLink, Async, CoverageBar, ErrorState, Hint, NoRecords, NotLoaded, PageHeader, Panel, RankedBars, Skeleton, SkeletonRows, SplitBar, SplitKey, Stat, StatRow, Tokens, Unknown, type SplitPart } from '../components/ui';
import { harnessFamily, harnessName } from '../lib/harness';
import { providerIcon } from '../lib/icons';
import { coverageRows, usageByProvider } from '../lib/analytics';
import { useAgents, useCollectorReadiness, useFieldReport, useFilters, useModels, useModelTurns, useQuality, useQualityReport, useQuota, useThreads } from '../lib/data';
import { fmtInt, fmtPct, fmtRelative, isKnown } from '../lib/format';

const QUALITIES = ['complete', 'partial', 'inferred', 'unavailable'];
const QUALITY_TONE: Record<string, SplitPart['tone']> = { complete: 'solid', partial: 'soft', inferred: 'faint', unavailable: 'missing' };
const USAGE_KEY: Pick<SplitPart, 'key' | 'tone' | 'name'>[] = [{ key: 'c', tone: 'solid', name: 'Complete' }, { key: 'p', tone: 'soft', name: 'Partial' }, { key: 'n', tone: 'missing', name: 'None' }];
const KIND_LABEL: Record<string, string> = { tool: 'Tool calls', answer: 'Answers', prompt: 'Prompts', run: 'Runs', model_turn: 'Turns and log hours', thread: 'Threads', agent: 'Sub-agents', project: 'Projects', instance: 'Instances', external_request: 'External requests' };

const GAPS: [string, string][] = [
  ['Model calls', 'Tokens are reported per provider turn, and one turn can contain several model calls. Calls stay null and turns are never counted as calls.'],
  ['Cost', 'Pricing is not captured, so no cost is derived from tokens.'],
  ['Historical quota', 'No snapshots were found. Past unused capacity cannot be reconstructed.'],
  ['Older messages', 'Migrated messages with no provably terminal run are excluded and counted in completed import-quality reports.'],
  ['Streaming content', 'Active message chunks are deliberately not stored.'],
  ['Clock offset', 'Source timestamps are retained. Remote clock offset has not been measured.'],
];

export default function DataQuality() {
  const { hrefPage } = useUrl();
  const { instance, status } = useFilters();
  const f = { instance, status };
  const quality = useQuality(f);
  const [showKinds, setShowKinds] = useState(false);
  const report = useQualityReport(f);
  const readiness = useCollectorReadiness();
  const threads = useThreads(f);
  const agents = useAgents(f);
  // Counted by the service over every tool call, so the coverage is never a sample.
  const fields = useFieldReport(f);
  const turns = useModelTurns(f);
  const models = useModels(f);
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
  const callsKnown = (models.data ?? []).filter((m) => isKnown(m.calls)).length;
  // Model calls is one more field, counted the same way as the rest so every total on the page agrees.
  const coverage = useMemo(() => {
    if (!(threads.data && agents.data && toolFields && turnRows)) return null;
    const rows = coverageRows(threads.data.rows, agents.data.rows, toolFields, turnRows);
    return models.data?.length ? [...rows, { id: 'model-calls', entity: 'Models', field: 'Model calls', known: callsKnown, total: models.data.length, note: 'One provider turn can contain several calls, so turns are never substituted for this.' }] : rows;
  }, [threads.data, agents.data, toolFields, turnRows, models.data, callsKnown]);
  const redactions = fields.data?.redactions ?? [];
  const providers = useMemo(() => usageByProvider(turns.data?.rows ?? []), [turns.data]);
  const turnTotal = providers.reduce((a, p) => a + p.turns, 0);
  const turnReported = providers.reduce((a, p) => a + p.complete + p.partial, 0);
  const silentProviders = providers.filter((p) => p.turns > 0 && p.unavailable === p.turns).map((p) => p.provider);
  const measured = coverage?.filter((c) => c.total > 0) ?? [];
  const coverageFailed = !coverage && !!(threads.error ?? agents.error ?? fields.error ?? turns.error);
  const full = measured.filter((c) => c.known === c.total).length;
  const none = measured.filter((c) => c.known === 0).length;
  const neverFields = measured.filter((c) => c.known === 0).map((c) => c.field);
  const checkpoints = report.data?.checkpoints;
  const projectCheckpoints = report.data?.project_checkpoints;
  const importErrors = report.data?.import_reports?.flatMap((r) => r.project_errors ?? []) ?? [];

  return (
    <>
      <PageHeader title="Data Quality" lead="What each number can support." />
      {report.data?.scope_reason && <p className="fine" role="status">{report.data.scope_reason}</p>}
      {(providers.length > 0 || measured.length > 0) && (
        <ul className="dq-verdict" aria-label="In short">
          {readiness.data?.collector?.state && !['running', 'idle', 'starting'].includes(readiness.data.collector.state) && <li><CircleSlash size={14} aria-hidden="true" className="dq-warn" /><span>The collector is <b>{readiness.data.collector.state}</b>, so nothing new is being read. <AppLink className="link" href={hrefPage('Settings')}>Capture settings</AppLink></span></li>}
          {turnTotal > 0 && <li><CheckCircle2 size={14} aria-hidden="true" className="dq-good" /><span>Token usage reported on <b>{fmtPct(turnReported / turnTotal)}</b> of provider turns{silentProviders.length ? <>; <b>{silentProviders.map((p) => harnessName(p)).join(', ')}</b> {silentProviders.length === 1 ? 'sends' : 'send'} none</> : ''}.</span></li>}
          {neverFields.length > 0 && <li><CircleSlash size={14} aria-hidden="true" className="dq-part" /><span>Never captured: <b>{neverFields.join(', ')}</b>.</span></li>}
          {measured.length > 0 && <li><CircleDashed size={14} aria-hidden="true" className="dq-part" /><span><b>{fmtInt(measured.length - full - none)}</b> fields are partly known, <b>{fmtInt(full)}</b> fully.</span></li>}
        </ul>
      )}

      {checkpoints !== undefined && (
        <Panel title="Collection coverage" sub={instance || status ? 'Installation-wide · all machines and run statuses' : undefined} hint="Source freshness is separate from whether the service is reachable.">
          {!checkpoints.length && <p role="status">No complete instance sync has finished. Backfill may still be running; totals describe the records imported so far.</p>}
          <dl className="facts-chips">
            <div><dt>Collector</dt><dd>{(() => {
              const st = readiness.data?.collector?.state;
              if (!st) return <Unknown label="Unavailable" />;
              const running = st === 'running' || st === 'idle' || st === 'starting';
              return <><span className={`status status-${running ? 'good' : st === 'disabled' ? 'warn' : 'crit'}`}>{running ? <CheckCircle2 size={13} aria-hidden="true" /> : <CircleSlash size={13} aria-hidden="true" />}{st === 'starting' ? 'Ingesting retained history' : st}</span></>;
            })()}</dd></div>
            <div><dt>Project checkpoints</dt><dd>{projectCheckpoints ? fmtInt(projectCheckpoints.length) : <Unknown label="Unavailable" />}</dd></div>
            <div><dt>Missing thread links{instance || status ? ' in scope' : ''}</dt><dd>{report.data?.missing_thread_relationships === undefined ? <Unknown label="Unavailable" /> : fmtInt(report.data.missing_thread_relationships)}</dd></div>
            <div><dt>Import reports</dt><dd>{report.data?.import_reports?.length ? fmtInt(report.data.import_reports.length) : 'None yet'}</dd></div>
            <div><dt>Quota</dt><dd>{quota.isError && !quota.data ? <NotLoaded /> : quota.data?.data?.length ? 'Sampling' : quota.isPending ? '…' : <Unknown label="Unavailable" why={quota.data?.reason} />}</dd></div>
            {checkpoints.map((c) => <div key={c.instance_id}><dt>Last sync · {c.instance_id}</dt><dd><time dateTime={c.last_successful_sync_at}>{fmtRelative(c.last_successful_sync_at)}</time></dd></div>)}
          </dl>
          {(report.data?.sync_progress ?? []).map((p, i) => <p key={i} role="status">{p.project_id ? <>Latest import progress: project {p.project_position ?? '?'} of {p.projects_discovered ?? '?'}: <code>{p.project_id}</code>. {p.committed_changes_in_project === undefined ? <Unknown label="Unavailable" /> : fmtInt(p.committed_changes_in_project)} committed changes in this project.</> : <>{p.projects_completed_this_pass ?? '?'} of {p.projects_discovered ?? '?'} projects completed in the latest pass ({p.state ?? 'status unavailable'}).</>}</p>)}
          {importErrors.length > 0 && <ul>{importErrors.map((e, i) => <li key={`${e.project_id}:${i}`}><code>{e.project_id}</code>: {e.error_category}</li>)}</ul>}
        </Panel>
      )}

      <StatRow label="Quality summary">
        <Stat label="Records" value={quality.isError ? <NotLoaded /> : quality.isPending ? '…' : fmtInt(total)} sub="Across all kinds" />
        <Stat label="Fields fully known" value={coverageFailed ? <NotLoaded /> : coverage ? `${fmtInt(full)} of ${fmtInt(measured.length)}` : '…'} sub={coverage ? `${fmtInt(none)} never captured` : undefined} />
      </StatRow>

      <Panel
        title="Field coverage"
        sub="Fields with gaps"
        hint="Solid is the share of records where the field holds a value. Hatched is missing, which is not the same as zero."
      >
        {threads.error ?? agents.error ?? fields.error ? <ErrorState error={threads.error ?? agents.error ?? fields.error} onRetry={() => { threads.refetch(); agents.refetch(); fields.refetch(); }} compact />
          : !coverage ? <SkeletonRows rows={10} label="Measuring coverage" />
            : (
              <>
                <ul className="coverage-list">
                  {coverage.filter((c) => c.total > 0 && c.known < c.total && c.known > 0).sort((a, b) => a.known / a.total - b.known / b.total).map((c) => (
                    <li key={c.id}>
                      <div className="coverage-head">
                        <span className="coverage-name"><small>{c.entity}</small>{c.field}<Hint label={`About ${c.field}`}>{c.note}</Hint></span>
                        <span className="coverage-count">{fmtPct(c.known / c.total)} <small>{fmtInt(c.known)} of {fmtInt(c.total)}</small></span>
                      </div>
                      <CoverageBar known={c.known} total={c.total} label={`${c.entity}, ${c.field}`} />
                    </li>
                  ))}
                </ul>
                {coverage.some((c) => c.total > 0 && c.known === c.total) && (
                  <p className="coverage-full"><CheckCircle2 size={13} aria-hidden="true" /> Fully known: {coverage.filter((c) => c.total > 0 && c.known === c.total).map((c, i) => <span key={c.id}>{i > 0 && ' · '}{c.field} <small>({c.entity.toLowerCase()})</small></span>)}</p>
                )}
              </>
            )}
      </Panel>

      <div className="split">
        <Panel className="grow-2" title="Token usage by provider" hint="Whether each provider reported usage for its turns. Provider turns only: hourly session-log blocks are records too, but never turns, so this counts fewer than the records below." action={<SplitKey parts={USAGE_KEY} />} flush>
          {turns.isPending ? <div className="pad"><SkeletonRows rows={4} label="Loading provider usage" /></div>
            : turns.isError ? <div className="pad"><ErrorState error={turns.error} onRetry={() => turns.refetch()} compact /></div>
              : !providers.length ? <div className="pad"><p className="fine">No provider turns recorded. This service may predate them.</p></div>
                : (
                  <div className="table-scroll card-table" tabIndex={0} role="region" aria-label="Token usage by provider">
                    <table className="sticky-first">
                      <thead><tr><th scope="col">Provider</th><th scope="col" className="num">Turns</th><th scope="col">Usage reported</th><th scope="col" className="num">Tokens</th></tr></thead>
                      <tbody>
                        {providers.map((p) => {
                          const Icon = providerIcon(harnessFamily(p.provider));
                          return (
                            <tr key={p.provider}>
                              <th scope="row"><span className="provider-cell"><Icon size={14} aria-hidden="true" />{harnessName(p.provider)}</span></th>
                              <td className="num" data-label="Turns">{fmtInt(p.turns)}</td>
                              <td className="wide-narrow" data-label="Usage reported">
                                <span className="mix-cell">
                                  <SplitBar label={`${p.provider} usage`} parts={[{ key: 'c', value: p.complete, tone: 'solid', name: 'Complete' }, { key: 'p', value: p.partial, tone: 'soft', name: 'Partial' }, { key: 'n', value: p.unavailable, tone: 'missing', name: 'None' }]} />
                                  <small>{p.complete === p.turns ? 'All complete' : p.unavailable === p.turns ? 'None reported' : [p.complete && `${fmtInt(p.complete)} complete`, p.partial && `${fmtInt(p.partial)} partial`, p.unavailable && `${fmtInt(p.unavailable)} none`].filter(Boolean).join(' · ')}</small>
                                </span>
                              </td>
                              <td className="num" data-label="Tokens">{p.total === null ? <Unknown label="Not reported" why="This provider reported no complete token total." /> : <>{(p.withTotal ?? p.turns) < p.turns && <span className="lower-bound" title={`${fmtInt(p.withTotal ?? 0)} of ${fmtInt(p.turns)} turns reported a total`}><span aria-hidden="true">≥ </span><span className="sr-only">at least </span></span>}<Tokens v={p.total} /></>}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
          {turns.data && !turns.data.complete && <p className="fine pad">Based on the latest {fmtInt(turns.data.scanned)} provider turns.</p>}
        </Panel>
        <Panel className="grow-1" title="Redactions" hint="Tool call and sub-agent records with a removed match.">
          {fields.isPending ? <SkeletonRows rows={4} label="Loading redactions" />
            : fields.isError ? <ErrorState error={fields.error} onRetry={() => fields.refetch()} compact />
            : redactions.length ? <RankedBars label="Records by redaction category" items={redactions.map((r) => ({ key: r.category, label: <span className="mono">{r.category}</span>, value: r.records }))} />
              : <p className="fine">No redactions in these records.</p>}
        </Panel>
      </div>


      <Panel title="Capture quality by kind" hint="The label stored on each record. Current sources are conservatively partial." action={matrix.qs.some((q) => matrix.grid.every((r) => r.cells[q] === r.total)) ? undefined : <SplitKey parts={matrix.qs.map((q) => ({ key: q, tone: QUALITY_TONE[q] ?? 'faint', name: q[0].toUpperCase() + q.slice(1) }))} />}>
        <Async query={quality} skeleton={<Skeleton height="12rem" label="Loading quality" />} isEmpty={(d) => !d.length} empty={<NoRecords />}>
          {() => {
            const only = matrix.qs.find((q) => matrix.grid.every((r) => r.cells[q] === r.total));
            const rows = (
              <ul className="quality-rows" aria-label="Capture quality by kind">
                {matrix.grid.map((r) => (
                  <li key={r.kind}>
                    <span>{KIND_LABEL[r.kind] ?? r.kind}</span>
                    <SplitBar label={KIND_LABEL[r.kind] ?? r.kind} parts={matrix.qs.map((q) => ({ key: q, value: r.cells[q] ?? 0, tone: QUALITY_TONE[q] ?? 'faint', name: q }))} />
                    <b>{fmtInt(r.total)}</b>
                  </li>
                ))}
              </ul>
            );
            return only ? (
              <>
                <p className="quality-one">Every one of the <b>{fmtInt(total)}</b> records is labelled <b>{only}</b>. <Hint label="Why every record is partial">This is the label the source stores on each record: current sources never promise every field, so they mark all records partial. How much is actually known is measured field by field above.</Hint></p>
                <button type="button" className="btn btn-quiet fold-btn" aria-expanded={showKinds} onClick={() => setShowKinds((v) => !v)}>{showKinds ? 'Hide the count by kind' : `Show the count by kind (${fmtInt(matrix.grid.length)})`}</button>
                {showKinds && rows}
              </>
            ) : rows;
          }}
        </Async>
      </Panel>

      <Panel title="Known gaps" hint="Limits of the current release. These constrain every chart.">
        <ul className="gap-chips">
          {GAPS.filter(([k]) => !(k === 'Model calls' && neverFields.includes('Model calls')) && !(k === 'Historical quota' && (quota.data?.data?.length ?? 0) > 0)).map(([k, v]) => <li key={k}>{k}<Hint label={`About ${k}`}>{v}</Hint></li>)}
        </ul>
      </Panel>
    </>
  );
}

import { useMemo } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { CheckCircle2, XCircle } from 'lucide-react';
import { Async, Command, PageHeader, Panel, Segmented, SelectField, SkeletonRows, Tag, Tokens, Unknown } from '../components/ui';
import { getJson } from '../lib/api';
import { useHealth, useThreads, useUsage } from '../lib/data';
import { fmtDateTime, fmtInt, fmtRelative } from '../lib/format';
import { browserTimezone, DEFAULTS, TIMEZONES, updateSettings, useSettings } from '../lib/settings';
import type { Entity, Envelope } from '../lib/types';

function useReady() {
  return useQuery({
    queryKey: ['ready'],
    retry: false,
    queryFn: async ({ signal }) => {
      const r = await fetch('/health/ready', { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as { ready: boolean };
    },
  });
}

export default function Settings() {
  const { timezone, density, pageSize } = useSettings();
  const health = useHealth();
  const ready = useReady();
  // The per-machine aggregate names each instance and counts its threads. Threads are read whole only when it is unavailable.
  const machines = useUsage('machines', {});
  const threads = useThreads({}, machines.isError);
  const instanceIds = useMemo(() => [...new Set(machines.data ? machines.data.map((m) => m.identity) : (threads.data?.rows ?? []).map((t) => t.instance_id))].sort(), [machines.data, threads.data]);
  const threadCount = (id: string) => machines.data ? machines.data.find((m) => m.identity === id)?.observed_threads ?? 0 : threads.data?.rows.filter((t) => t.instance_id === id).length ?? 0;
  const tzOptions = [...new Set([timezone, browserTimezone(), ...TIMEZONES])];

  return (
    <>
      <PageHeader title="Settings" lead="Saved in this browser. Capture is set in the CLI." />
      <div className="grid-2">
        <Panel title="Display" sub="Saved in this browser only">
          <div className="form">
            <SelectField label="Display timezone" value={timezone} onChange={(v) => updateSettings({ timezone: v })} options={tzOptions.map((z) => ({ value: z, label: z === browserTimezone() ? `${z} (this device)` : z }))} />
            <SelectField label="Table page size" value={String(pageSize)} onChange={(v) => updateSettings({ pageSize: Number(v) })} options={[25, 50, 100].map((n) => ({ value: String(n), label: `${n} rows` }))} />
            <Segmented label="Table density" hideLabel={false} value={density} onChange={(v) => updateSettings({ density: v })} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
            <p className="fine">Hourly buckets come from the API in UTC and are regrouped in this timezone. Default: {DEFAULTS.timezone}, matching the server configuration.</p>
          </div>
        </Panel>

        <Panel title="Service" sub="This page is served by the local process">
          <dl className="facts">
            <div><dt>Liveness</dt><dd><Health ok={health.isSuccess} pending={health.isPending} /></dd></div>
            <div><dt>Readiness</dt><dd><Health ok={ready.isSuccess && ready.data?.ready === true} pending={ready.isPending} /></dd></div>
            <div><dt>API</dt><dd className="mono">{location.origin}/api/v1</dd></div>
            <div><dt>Binding</dt><dd>{['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) ? 'Loopback' : 'Not loopback: do not expose this service'}</dd></div>
            <div><dt>External requests</dt><dd>None. Fonts and icons are bundled.</dd></div>
          </dl>
        </Panel>
      </div>

      <Panel title="Capture instances" sub="Each collector keeps its own identity">
        <Async<unknown> query={(machines.isError ? threads : machines) as UseQueryResult<unknown>} skeleton={<SkeletonRows rows={2} label="Loading instances" />} isEmpty={() => !instanceIds.length} compact>
          {() => <div className="instance-grid">{instanceIds.map((id) => <Instance key={id} id={id} threads={threadCount(id)} tz={timezone} totalTokens={machines.data?.find((m) => m.identity === id)?.total_tokens} />)}</div>}
        </Async>
      </Panel>

      <Panel title="Privacy and capture" sub="Default policy stores redacted text only. These change only through the CLI, so a browser session can never widen access.">
        <div className="command-grid">
          <div><h3>Pause capture</h3><Command text="runtrace capture pause" /></div>
          <div><h3>Resume capture</h3><Command text="runtrace capture resume" /></div>
          <div><h3>Metadata only for a project</h3><Command text="runtrace project privacy <t3-project-id> metadata_only" /></div>
          <div><h3>Purge a thread</h3><Command text="runtrace purge thread <t3-thread-id>" /></div>
          <div><h3>Purge a project</h3><Command text="runtrace purge project <t3-project-id>" /></div>
          <div><h3>Export redacted records</h3><Command text="runtrace export --output data/redacted-export.json" /></div>
        </div>
        <p className="fine">MCP exposes redacted content only. No endpoint decrypts full content. Stop the service before commands that write to the database.</p>
      </Panel>
    </>
  );
}

function Health({ ok, pending }: { ok: boolean; pending: boolean }) {
  if (pending) return <span className="fine">Checking…</span>;
  return ok
    ? <span className="status status-good"><CheckCircle2 size={13} aria-hidden="true" /> Healthy</span>
    : <span className="status status-crit"><XCircle size={13} aria-hidden="true" /> Not responding</span>;
}

function Instance({ id, threads, tz, totalTokens }: { id: string; threads: number; tz: string; totalTokens?: number | null }) {
  const q = useQuery({
    queryKey: ['instance', id],
    queryFn: async ({ signal }) => (await getJson<Envelope<Entity>>('timeline', new URLSearchParams({ id, instance: id, limit: '5' }), signal)).data?.find((e) => e.kind === 'instance') ?? null,
  });
  const d = q.data?.data ?? {};
  const caps = Array.isArray(d.capabilities) ? (d.capabilities as string[]) : [];
  return (
    <article className="instance">
      <h3>{typeof d.display_name === 'string' ? d.display_name : id}</h3>
      <dl className="facts">
        <div><dt>Instance id</dt><dd className="mono">{id}</dd></div>
        <div><dt>Connection</dt><dd>{typeof d.connection_type === 'string' ? d.connection_type : <Unknown label="Unknown" />}</dd></div>
        <div><dt>Source version</dt><dd className="mono">{typeof d.version === 'string' ? d.version : 'Unknown'}</dd></div>
        <div><dt>Threads</dt><dd>{fmtInt(threads)}</dd></div>
        <div><dt>Tokens</dt><dd><Tokens v={totalTokens} /></dd></div>
        <div><dt>Last written</dt><dd title={q.data?.captured_at ? fmtDateTime(q.data.captured_at, tz) : undefined}>{q.data?.captured_at ? fmtRelative(q.data.captured_at) : <Unknown label="Unknown" />}</dd></div>
        <div><dt>Quota adapter</dt><dd>{d.quota === 'unavailable' || !d.quota ? <Unknown label="Unavailable" /> : String(d.quota)}</dd></div>
      </dl>
      {caps.length > 0 && <div className="tags">{caps.map((c) => <Tag key={c}>{c}</Tag>)}</div>}
    </article>
  );
}

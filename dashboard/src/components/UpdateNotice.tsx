import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpCircle, X } from 'lucide-react';

/** The service's update state (see update::UpdateStatus): disabled, not_checked, up_to_date, available, applying or apply_failed. */
interface UpdateStatus { state?: string; current: string; latest?: string; available: boolean; url?: string; notes?: string | null; published_at?: string; log?: string }

/** The service checks GitHub about once a day. When a newer release exists, a button in the top bar offers it. */
export function UpdateNotice() {
  const status = useQuery({
    queryKey: ['update'],
    refetchInterval: 60 * 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const res = await fetch('/api/v1/update', { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as UpdateStatus;
    },
  });
  const [open, setOpen] = useState(false);
  // Offered while a newer release is known, while one is being installed (perhaps from another tab), and after a failed try.
  const s = status.data;
  if (!s || !(s.available || s.state === 'applying' || s.state === 'apply_failed')) return null;
  return (
    <>
      <button type="button" className="update-chip" onClick={() => setOpen(true)} title={`Runtrace ${status.data.latest} is available`}>
        <ArrowUpCircle size={14} aria-hidden="true" />
        <span>Update</span>
      </button>
      <UpdateDialog open={open} onClose={() => setOpen(false)} status={status.data} />
    </>
  );
}

type Phase = { kind: 'idle' } | { kind: 'starting' } | { kind: 'waiting'; since: number } | { kind: 'slow' } | { kind: 'failed'; message: string };

function UpdateDialog({ open, onClose, status }: { open: boolean; onClose: () => void; status: UpdateStatus }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  // An update another tab started is followed the same way as one started here.
  useEffect(() => {
    if (open && status.state === 'applying' && phase.kind === 'idle') setPhase({ kind: 'waiting', since: Date.now() });
  }, [open, status.state, phase.kind]);

  // While the service restarts it stops answering; once it answers with a new version the page reloads into it. While the old
  // one still answers, its update state says whether the updater gave up, so a failure shows at once instead of after minutes.
  useEffect(() => {
    if (phase.kind !== 'waiting') return;
    const timer = window.setInterval(async () => {
      if (Date.now() - phase.since > 4 * 60_000) { setPhase({ kind: 'slow' }); return; }
      try {
        const res = await fetch('/health/ready', { cache: 'no-store' });
        const body = (await res.json()) as { version?: string };
        if (body.version && body.version !== status.current) { location.reload(); return; }
        const u = (await (await fetch('/api/v1/update', { cache: 'no-store' })).json()) as UpdateStatus;
        if (u.state === 'apply_failed') setPhase({ kind: 'failed', message: `The update stopped before installing, and this version is still running.${u.log ? ` Details are in ${u.log}.` : ''}` });
      } catch { /* still restarting */ }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [phase, status.current]);

  const start = async () => {
    setPhase({ kind: 'starting' });
    try {
      const res = await fetch('/api/v1/update/apply', { method: 'POST', headers: { 'x-runtrace-action': 'update' } });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
        // Already running, perhaps from another tab: follow that one.
        if (body?.error?.code === 'update_running') { setPhase({ kind: 'waiting', since: Date.now() }); return; }
        setPhase({ kind: 'failed', message: `The update did not start: ${body?.error?.message ?? `the service answered ${res.status}.`}` });
        return;
      }
      setPhase({ kind: 'waiting', since: Date.now() });
    } catch {
      setPhase({ kind: 'failed', message: 'The update did not start: the service could not be reached.' });
    }
  };

  const busy = phase.kind === 'starting' || phase.kind === 'waiting';
  const notes = status.notes?.trim().split('\n').filter((l) => l.trim()).slice(0, 8).join('\n');
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onCancel={(e) => { if (busy) e.preventDefault(); }} aria-labelledby="update-title">
      <header className="dialog-head">
        <h2 id="update-title"><ArrowUpCircle size={16} aria-hidden="true" /> Runtrace {status.latest} is available</h2>
        <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close"><X size={15} aria-hidden="true" /></button>
      </header>
      <div className="dialog-body update-body">
        <p>You have {status.current}. Updating backs up the database, installs the new version and restarts Runtrace. It takes about a minute, and this page reloads by itself.</p>
        {notes && <pre className="update-notes">{notes}</pre>}
        {status.url && <p><a className="link" href={status.url} target="_blank" rel="noreferrer">What changed in {status.latest}</a></p>}
        <p role="status" aria-live="polite" className="fine">
          {phase.kind === 'starting' && 'Starting the update…'}
          {phase.kind === 'waiting' && 'Updating. Runtrace restarts, then this page reloads.'}
          {phase.kind === 'slow' && 'This is taking longer than expected. Run `runtrace status` in a terminal, or look in the logs folder it names.'}
          {phase.kind === 'failed' && phase.message}
        </p>
        <div className="update-actions">
          <button type="button" className="btn update-go" onClick={start} disabled={busy}>{busy ? 'Updating…' : 'Update now'}</button>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Later</button>
        </div>
      </div>
    </dialog>
  );
}

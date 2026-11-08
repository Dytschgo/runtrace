import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpCircle, X } from 'lucide-react';

interface UpdateStatus { current: string; latest?: string; available: boolean; url?: string; notes?: string | null; published_at?: string }

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
  if (!status.data?.available) return null;
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

  // While the service restarts it stops answering; once it answers with a new version the page reloads into it.
  useEffect(() => {
    if (phase.kind !== 'waiting') return;
    const timer = window.setInterval(async () => {
      if (Date.now() - phase.since > 4 * 60_000) { setPhase({ kind: 'slow' }); return; }
      try {
        const res = await fetch('/health/ready', { cache: 'no-store' });
        const body = (await res.json()) as { version?: string };
        if (body.version && body.version !== status.current) location.reload();
      } catch { /* still restarting */ }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [phase, status.current]);

  const start = async () => {
    setPhase({ kind: 'starting' });
    try {
      const res = await fetch('/api/v1/update/apply', { method: 'POST', headers: { 'x-runtrace-action': 'update' } });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setPhase({ kind: 'failed', message: body?.error?.message ?? `The service answered ${res.status}.` });
        return;
      }
      setPhase({ kind: 'waiting', since: Date.now() });
    } catch {
      setPhase({ kind: 'failed', message: 'The service could not be reached.' });
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
          {phase.kind === 'failed' && `The update did not start: ${phase.message}`}
        </p>
        <div className="update-actions">
          <button type="button" className="btn update-go" onClick={start} disabled={busy}>{busy ? 'Updating…' : 'Update now'}</button>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Later</button>
        </div>
      </div>
    </dialog>
  );
}

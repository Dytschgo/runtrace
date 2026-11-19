export interface CollectorHealth { state?: string; last_successful_sync_at?: string }
export interface CollectionNotice { state: string; title: string; detail: string; lastSync?: string }

/** Process liveness and source freshness are separate observations. */
export function collectionNotice(collector: CollectorHealth | undefined, pollSeconds: number | undefined, now: number): CollectionNotice | null {
  if (!collector) return null;
  const lastSync = collector.last_successful_sync_at;
  const last = lastSync ? Date.parse(lastSync) : NaN;
  const base = { state: collector.state ?? 'unknown', lastSync: Number.isFinite(last) ? lastSync : undefined };
  switch (collector.state) {
    case 'disabled': return { ...base, title: 'Automatic collection is off.', detail: 'Showing stored history.' };
    case 'paused': return { ...base, title: 'Collection is paused.', detail: 'No new source data is being read.' };
    case 'starting': return { ...base, title: 'Collection is starting.', detail: 'The first complete sync has not finished.' };
    case 'partial': return { ...base, title: 'Collection is partial.', detail: 'Some source projects could not be read.' };
    case 'retrying': return { ...base, title: 'Collection is retrying.', detail: 'The last attempt failed; stored history remains available.' };
    case 'failed': return { ...base, title: 'Collection has stopped.', detail: 'The collector cannot continue until the service restarts.' };
    case 'synced': {
      if (!Number.isFinite(last)) return { ...base, title: 'Collection freshness is unknown.', detail: 'No successful sync time was reported.' };
      if (last > now + 5 * 60_000) return { ...base, title: 'Collector clock is ahead.', detail: 'Its sync time cannot establish freshness for this browser.' };
      const poll = pollSeconds && Number.isFinite(pollSeconds) && pollSeconds > 0 ? pollSeconds : 60;
      return now - last > Math.max(180_000, poll * 3_000) ? { ...base, state: 'stale', title: 'Collection is stale.', detail: 'No successful sync arrived within three polling intervals.' } : null;
    }
    default: return { ...base, title: 'Collection status is unknown.', detail: 'The service did not report a recognized collector state.' };
  }
}

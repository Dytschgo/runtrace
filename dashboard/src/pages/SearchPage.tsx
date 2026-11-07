import { useQuery } from '@tanstack/react-query';
import { FileText, SearchX } from 'lucide-react';
import { Pager } from '../components/DataTable';
import { AppLink, Async, EmptyState, PageHeader, Panel, SkeletonRows } from '../components/ui';
import { getEntities } from '../lib/api';
import { useFilters } from '../lib/data';
import { apiParams } from '../lib/filters';
import { cleanText, fmtDay, fmtClock, snippet } from '../lib/format';
import { useSettings } from '../lib/settings';
import type { Entity } from '../lib/types';
import { useUrl } from '../lib/url';
import { KIND } from './ActivityPage';

const LIMIT = 25;

export default function SearchPage() {
  const { params, set, hrefPage } = useUrl();
  const { timezone } = useSettings();
  const f = useFilters();
  const q = params.get('q')?.trim() ?? '';
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const query = useQuery<Entity[]>({
    queryKey: ['search', q, apiParams('search', f).toString(), offset],
    enabled: !!q,
    placeholderData: (prev) => prev,
    queryFn: ({ signal }) => getEntities<Entity>('search', apiParams('search', f, { q, limit: LIMIT, offset, include_content: 'true' }), signal),
  });

  return (
    <>
      <PageHeader title="Search" lead={q ? <>Results for “{q}” in redacted content.</> : 'Search redacted prompts, answers, tool calls and sub-agent records.'} />
      <Panel flush>
        {!q ? (
          <EmptyState title="Type a search above"><p>Thread titles are filtered on the Threads page. Text removed by redaction cannot be found.</p></EmptyState>
        ) : (
          <div className="pad">
            <Async
              query={query}
              skeleton={<SkeletonRows rows={8} label="Searching" />}
              isEmpty={(d) => !d.length && offset === 0}
              empty={<EmptyState icon={<SearchX size={20} />} title="No matches"><p>Nothing in the redacted content contains “{q}”. Filters also apply, and text removed by redaction cannot be found.</p></EmptyState>}
            >
              {(rows) => (
                <>
                  <ol className="results">
                    {rows.map((r) => {
                      const K = KIND[r.kind];
                      const Icon = K?.icon ?? FileText;
                      const text = cleanText(typeof r.data?.content_redacted === 'string' ? r.data.content_redacted : '');
                      const s = snippet(text, q);
                      return (
                        <li key={r.id}>
                          <div className="result-head">
                            <span className="feed-kind"><Icon size={13} aria-hidden="true" /> {K?.label ?? r.kind}</span>
                            <time dateTime={r.occurred_at}>{fmtDay(r.occurred_at, timezone)} {fmtClock(r.occurred_at, timezone)}</time>
                          </div>
                          <p className="result-text">{s.before}{s.match && <mark>{s.match}</mark>}{s.after}</p>
                          {r.thread_id && <AppLink className="link" href={hrefPage('Threads', { id: r.thread_id })}>Open thread</AppLink>}
                        </li>
                      );
                    })}
                  </ol>
                  <div className="table-foot">
                    <Pager offset={offset} limit={LIMIT} shown={rows.length} hasMore={rows.length === LIMIT} onPage={(o) => set({ offset: o || null })} />
                  </div>
                </>
              )}
            </Async>
          </div>
        )}
      </Panel>
    </>
  );
}

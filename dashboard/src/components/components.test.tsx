import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { buildHeatmap } from '../lib/analytics';
import { updateSettings } from '../lib/settings';
import { pushSearch } from '../lib/url';
import { ActivityHeatmap } from './heatmap';
import { DataTable, Pager, sortRows, type Column } from './DataTable';
import { isTypingTarget } from './Shell';
import { TokenFacts } from './tokens';
import { AppLink, Async, ChartPanel, CoverageBar, ErrorState, QualityBadge, RankedBars, ScanNote, StatusBadge, Tokens, Unknown, Val } from './ui';

function withClient(children: ReactNode) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}

describe('explicit gaps', () => {
  it('shows zero as a value and null as not captured', () => {
    const { rerender } = render(<Val v={0} />);
    expect(screen.getByText('0')).toBeInTheDocument();
    rerender(<Val v={null} why="No adapter" />);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.getByText('Not captured')).toHaveAttribute('title', 'No adapter');
  });
  it('exposes why a value is missing to screen readers', () => {
    render(<Unknown why="Needs a provider transcript adapter." />);
    expect(screen.getByText(/Needs a provider transcript adapter/)).toHaveClass('sr-only');
  });
  it('gives a missing status its own mark and a known one icon plus label', () => {
    const { rerender } = render(<StatusBadge status={null} />);
    expect(screen.getByText('Unknown')).toHaveClass('unknown');
    rerender(<StatusBadge status="failed" />);
    expect(screen.getByText('Failed')).toHaveClass('status-crit');
  });
  it('states coverage as a text alternative', () => {
    render(<CoverageBar known={67} total={102} label="Delivery" />);
    expect(screen.getByRole('img', { name: 'Delivery: 67 of 102 known' })).toBeInTheDocument();
  });
  it('explains each capture quality', () => {
    render(<QualityBadge quality="partial" />);
    expect(screen.getByText('partial')).toHaveAttribute('title', expect.stringContaining('not available'));
  });
  it('says when a scan read only part of the history and offers the rest', async () => {
    const onExpand = vi.fn();
    const { rerender } = render(<ScanNote scanned={1000} complete={false} total={4269} noun="calls" onExpand={onExpand} />);
    expect(screen.getByText(/Latest 1,000 of 4,269 calls/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Analyze all' }));
    expect(onExpand).toHaveBeenCalled();
    rerender(<ScanNote scanned={4269} complete noun="calls" />);
    expect(screen.getByText('All 4,269 calls read')).toBeInTheDocument();
  });
});

describe('token display', () => {
  const base = { cached: null, reasoning: null, output: null, complete: 0, noUsage: [] as string[] };

  it('shows reported totals with their coverage, not a global gap', () => {
    render(<TokenFacts s={{ ...base, total: 1_915_041_710, input: 1_907_454_338, cached: 1_868_581_632, output: 7_587_372, reasoning: 2_826_618, turns: 737, withUsage: 735, complete: 729, noUsage: ['grok-4.7'] }} />);
    expect(screen.getByTitle('At least 1,915,041,710 tokens')).toHaveTextContent('≥at least 1.9B');
    expect(screen.getByText(/98% of input/)).toBeInTheDocument();
    expect(screen.getByText(/735 of 737 turns reported usage, 729 of them in full/)).toBeInTheDocument();
    expect(screen.getByText('grok-4.7')).toBeInTheDocument();
    expect(screen.queryByText('Not captured')).not.toBeInTheDocument();
  });
  it('states the gap only when nothing in view reported usage', () => {
    render(<TokenFacts s={{ ...base, total: null, input: null, turns: 41, withUsage: 0 }} />);
    expect(screen.getByText('Not captured')).toBeInTheDocument();
    expect(screen.getByText('None of the 41 provider turns in this view reported usage.')).toBeInTheDocument();
  });
  it('falls back cleanly on a service without provider turns', () => {
    render(<TokenFacts s={{ ...base, total: null, input: null, turns: null, withUsage: null }} />);
    expect(screen.getByText('This service does not report provider turns yet.')).toBeInTheDocument();
  });
  it('shows cache-write coverage and keeps cache writes out of the total', () => {
    const { rerender } = render(<TokenFacts s={{ ...base, total: 110, input: 100, cacheWrite: 20, cacheWriteTurns: 2, turns: 3, withUsage: 3 }} />);
    expect(screen.getByTitle('At least 110 tokens')).toBeInTheDocument();
    expect(screen.getByText('Cache writes').nextElementSibling).toHaveTextContent('20');
    expect(screen.getByText(/recorded for 2 of 3 turns/)).toBeInTheDocument();
    expect(screen.getByText(/cache writes are included in input/)).toBeInTheDocument();
    rerender(<TokenFacts s={{ ...base, total: 0, input: 0, cacheWrite: 0, cacheWriteTurns: 1, turns: 1, withUsage: 1 }} />);
    expect(screen.getByText('Cache writes').nextElementSibling).toHaveTextContent('0');
    rerender(<TokenFacts s={{ ...base, total: 110, input: 100, cacheWrite: null, cacheWriteTurns: 0, turns: 3, withUsage: 3 }} />);
    expect(screen.getByText('Cache writes').nextElementSibling).toHaveTextContent('Not reported');
  });
  it('retains partial cache-write observations without known input or total', () => {
    render(<TokenFacts s={{ ...base, total: null, input: null, cacheWrite: 20, cacheWriteTurns: 1, turns: 2, withUsage: 1 }} />);
    expect(screen.getByText('Cache writes').nextElementSibling).toHaveTextContent('20');
    expect(screen.queryByText(/None of the/)).not.toBeInTheDocument();
  });
  it('never renders a null count as zero', () => {
    const { rerender } = render(<Tokens v={null} />);
    expect(screen.getByText('Not captured')).toBeInTheDocument();
    rerender(<Tokens v={0} />);
    expect(screen.getByText('0')).toBeInTheDocument();
  });
});

describe('Async states', () => {
  function Harness({ fn, isEmpty }: { fn: () => Promise<string[]>; isEmpty?: (d: string[]) => boolean }) {
    const q = useQuery({ queryKey: ['x'], queryFn: fn });
    return <Async query={q} skeleton={<div role="status">Loading</div>} isEmpty={isEmpty}>{(d) => <p>{d.join(',')}</p>}</Async>;
  }
  it('moves from loading to content', async () => {
    render(withClient(<Harness fn={async () => ['a']} />));
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(await screen.findByText('a')).toBeInTheDocument();
  });
  it('tells empty apart from failure', async () => {
    render(withClient(<Harness fn={async () => []} isEmpty={(d) => !d.length} />));
    expect(await screen.findByText('No records match')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('recovers through Retry', async () => {
    const fn = vi.fn<() => Promise<string[]>>().mockRejectedValueOnce(new ApiError('offline', 'The local analytics service is not responding.')).mockResolvedValue(['back']);
    render(withClient(<Harness fn={fn} />));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Analytics service unreachable')).toBeInTheDocument();
    expect(within(alert).getByText('t3ui serve')).toBeInTheDocument();
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('back')).toBeInTheDocument();
  });
  it('names rejected filters as a filter problem', () => {
    render(<ErrorState error={new ApiError('invalid', 'Bad date')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Query rejected');
    expect(screen.queryByText('t3ui serve')).not.toBeInTheDocument();
  });
});

interface Row { name: string; n: number | null }
const columns: Column<Row>[] = [
  { key: 'name', header: 'Name', sort: (r) => r.name, render: (r) => r.name },
  { key: 'n', header: 'Count', align: 'end', sort: (r) => r.n, render: (r) => r.n ?? 'none' },
];
const manyRows: Row[] = Array.from({ length: 60 }, (_, i) => ({ name: `row-${String(i).padStart(2, '0')}`, n: i }));

describe('DataTable', () => {
  const firstCell = () => within(screen.getAllByRole('row')[1]).getAllByRole('cell')[0];

  it('sorts nulls last in both directions', () => {
    const rows: Row[] = [{ name: 'a', n: null }, { name: 'b', n: 2 }, { name: 'c', n: 9 }];
    expect(sortRows(rows, columns[1], 'desc').map((r) => r.name)).toEqual(['c', 'b', 'a']);
    expect(sortRows(rows, columns[1], 'asc').map((r) => r.name)).toEqual(['b', 'c', 'a']);
  });
  it('keeps sort in the URL and reports it through aria-sort', async () => {
    render(<DataTable rows={manyRows} columns={columns} rowKey={(r) => r.name} caption="Rows" defaultSort={{ key: 'n', dir: 'desc' }} />);
    expect(firstCell()).toHaveTextContent('row-59');
    expect(screen.getByRole('columnheader', { name: 'Count' })).toHaveAttribute('aria-sort', 'descending');
    await userEvent.click(screen.getByRole('button', { name: 'Count' }));
    expect(new URLSearchParams(location.search).get('dir')).toBe('asc');
    expect(firstCell()).toHaveTextContent('row-00');
    expect(screen.getByRole('columnheader', { name: 'Count' })).toHaveAttribute('aria-sort', 'ascending');
  });
  it('pages through the URL and restores from it', async () => {
    updateSettings({ pageSize: 25 });
    render(<DataTable rows={manyRows} columns={columns} rowKey={(r) => r.name} caption="Rows" defaultSort={{ key: 'name', dir: 'asc' }} />);
    expect(screen.getByText('1–25 of 60')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(new URLSearchParams(location.search).get('offset')).toBe('25');
    expect(screen.getByText('26–50 of 60')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('51–60 of 60')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });
  it('recovers from an offset beyond the filtered rows', () => {
    pushSearch('?offset=9000');
    render(<DataTable rows={manyRows} columns={columns} rowKey={(r) => r.name} caption="Rows" />);
    expect(screen.getByText('1–25 of 60')).toBeInTheDocument();
  });
  it('isolates a second table on the page with a prefix', async () => {
    render(<DataTable rows={manyRows} columns={columns} rowKey={(r) => r.name} caption="Rows" prefix="ts" defaultSort={{ key: 'name', dir: 'asc' }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    const p = new URLSearchParams(location.search);
    expect(p.get('tsoffset')).toBe('25');
    expect(p.get('offset')).toBeNull();
  });
  it('labels the scroll region so keyboard users can reach it', () => {
    render(<DataTable rows={manyRows} columns={columns} rowKey={(r) => r.name} caption="Tool calls" />);
    expect(screen.getByRole('region', { name: 'Tool calls' })).toHaveAttribute('tabindex', '0');
  });
  it('shows the supplied empty state instead of an empty table', () => {
    render(<DataTable rows={[]} columns={columns} rowKey={(r) => r.name} caption="Rows" empty={<p>Nothing here</p>} />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
  it('lets a pager with no total advance only while pages stay full', async () => {
    const onPage = vi.fn();
    const { rerender } = render(<Pager offset={0} limit={25} shown={25} hasMore onPage={onPage} />);
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPage).toHaveBeenCalledWith(25);
    rerender(<Pager offset={25} limit={25} shown={3} hasMore={false} onPage={onPage} />);
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });
});

describe('navigation', () => {
  it('moves with history on a plain click and leaves modified clicks to the browser', async () => {
    render(<AppLink href="?page=Models">Models</AppLink>);
    await userEvent.click(screen.getByRole('link', { name: 'Models' }));
    expect(location.search).toBe('?page=Models');
    history.replaceState({}, '', '/');
    const noNav = vi.fn((e: Event) => e.preventDefault());
    document.addEventListener('click', noNav);
    screen.getByRole('link', { name: 'Models' }).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    document.removeEventListener('click', noNav);
    expect(location.search).toBe('');
  });
  it('does not treat typing in a field as a shortcut', () => {
    expect(isTypingTarget(document.createElement('input'))).toBe(true);
    expect(isTypingTarget(document.createElement('select'))).toBe(true);
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
  });
});

describe('charts and lists', () => {
  it('ranked bars link, show share and report what is hidden', () => {
    render(<RankedBars label="Models" total={100} limit={1} items={[{ key: 'a', label: 'alpha', value: 70, href: '?page=Models' }, { key: 'b', label: 'beta', value: 30 }]} />);
    expect(screen.getByRole('link', { name: 'alpha' })).toBeInTheDocument();
    expect(screen.getByText('70%')).toBeInTheDocument();
    expect(screen.queryByText('beta')).not.toBeInTheDocument();
    expect(screen.getByText('1 more not shown')).toBeInTheDocument();
  });
  it('switches a chart to the same data as a table', async () => {
    render(<ChartPanel title="Trend" chart={<div>chart-body</div>} table={<table><tbody><tr><td>row-body</td></tr></tbody></table>} />);
    expect(screen.getByText('chart-body')).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Show as table' });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('row-body')).toBeInTheDocument();
    expect(screen.queryByText('chart-body')).not.toBeInTheDocument();
  });
  it('heatmap is one tab stop with arrow-key reading', async () => {
    const data = buildHeatmap([{ hour: '2026-11-02T09:00:00Z', prompts: 5 }], 'UTC'); // Monday 09:00
    render(<ActivityHeatmap data={data} />);
    const cells = screen.getByRole('grid').querySelectorAll('[tabindex="0"]');
    expect(cells).toHaveLength(1);
    expect(cells[0]).toHaveAccessibleName('Mon 9:00, 5 prompts');
    (cells[0] as HTMLElement).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toHaveAccessibleName('Mon 10:00, 0 prompts');
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toHaveAccessibleName('Tue 10:00, 0 prompts');
    expect(screen.getByText('Tue 10:00 · 0 prompts')).toBeInTheDocument();
  });
});

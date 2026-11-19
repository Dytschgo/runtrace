import { describe, expect, it } from 'vitest';
import { apiParams, cleanSearch, resolveFilters } from './filters';
import { pageSearch, PAGES } from './url';

describe('global machine and containing-run status', () => {
  it('survives every page link and reload without taking the tool-call status with it', () => {
    for (const page of [...PAGES, 'Search'] as const) {
      const next = pageSearch('?page=Tool+Calls&instance=machine-east&run_status=failed&status=completed&id=example', page);
      const params = new URLSearchParams(next);
      expect(resolveFilters(params)).toMatchObject({ instance: 'machine-east', status: 'failed' });
      expect(params.has('status')).toBe(false);
      expect(params.has('id')).toBe(false);
    }
  });
  it('sends both global filters to all data routes, while keeping time off metadata pages', () => {
    const filters = { instance: 'machine-east', status: 'failed', since: '2026-01-01T00:00:00Z' };
    for (const route of ['overview', 'models', 'projects', 'threads', 'agents', 'timeline', 'search', 'model-turns', 'tool-calls', 'usage/projects', 'usage/machines', 'usage/efficiency', 'data-quality', 'data-quality/fields', 'storage', 'quota/current', 'quota/live', 'quota/samples']) {
      const params = apiParams(route, filters);
      expect(params.get('instance'), route).toBe('machine-east');
      expect(params.get('run_status'), route).toBe('failed');
    }
    expect(apiParams('quota/samples', filters).get('since')).toBe(filters.since);
    expect(apiParams('projects', filters).has('since')).toBe(false);
  });
  it('removes invalid run-status values while preserving the separate call-status filter', () => {
    expect(cleanSearch('?run_status=unknown&status=unknown', PAGES)).toBe('status=unknown');
    expect(resolveFilters(new URLSearchParams('run_status=unknown')).status).toBeUndefined();
  });
});

"""Affirmative completion gates shared by the storage benchmark and its tests."""

MEMORY_CEILING_BYTES = 400_000_000


def validate_full_import(report, expected_projects, expected_threads, peak_bytes):
    """Reject partial, paused, underspecified and over-budget benchmark imports."""
    if type(expected_projects) is not int or expected_projects < 1:
        raise ValueError('Qualification needs at least one active source project')
    if type(expected_threads) is not int or expected_threads < 0:
        raise ValueError('Invalid expected source thread count')
    if report.get('paused') is True or report.get('dry_run') is not False:
        raise ValueError('Paused or dry-run import is not a completed full import')
    if report.get('partial_sync') is not False or report.get('project_errors') != []:
        raise ValueError('Every source project must complete without errors')
    for key, expected in [('projects_discovered', expected_projects),
                          ('projects_synced', expected_projects),
                          ('threads_discovered', expected_threads)]:
        if type(report.get(key)) is not int or report[key] != expected:
            raise ValueError(f'{key} does not match the frozen source')
    if type(report.get('changed')) is not int or report['changed'] <= 0:
        raise ValueError('A first import must actually populate the empty store')
    if type(peak_bytes) is not int or peak_bytes <= 0 or peak_bytes > MEMORY_CEILING_BYTES:
        raise ValueError('Peak working set is missing or exceeds 400 MB')

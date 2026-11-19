import unittest
from storage_qualification import validate_full_import


class StorageQualificationTests(unittest.TestCase):
    def report(self):
        return dict(partial_sync=False, project_errors=[], dry_run=False,
                    projects_discovered=2, projects_synced=2,
                    threads_discovered=3, changed=10)

    def test_complete_import_at_the_ceiling_passes(self):
        validate_full_import(self.report(), 2, 3, 400_000_000)

    def test_paused_and_dry_runs_fail_even_with_complete_counters(self):
        for update in [dict(paused=True), dict(dry_run=True), dict(partial_sync=True),
                       dict(project_errors=[dict(error_category='database_memory_limit')])]:
            with self.subTest(update=update), self.assertRaises(ValueError):
                validate_full_import(self.report() | update, 2, 3, 100_000_000)

    def test_every_required_counter_and_completion_field_is_affirmative(self):
        for key in self.report():
            report = self.report()
            del report[key]
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_full_import(report, 2, 3, 100_000_000)

    def test_partial_project_and_thread_discovery_fail(self):
        for key in ['projects_discovered', 'projects_synced', 'threads_discovered']:
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_full_import(self.report() | {key: 1}, 2, 3, 100_000_000)

    def test_missing_and_over_limit_measurements_fail_for_every_mode(self):
        for peak in [0, -1, 400_000_001]:
            with self.subTest(peak=peak), self.assertRaises(ValueError):
                validate_full_import(self.report(), 2, 3, peak)

    def test_false_counters_and_empty_source_cannot_substitute_for_work(self):
        for update in [dict(projects_synced=True), dict(changed=0)]:
            with self.subTest(update=update), self.assertRaises(ValueError):
                validate_full_import(self.report() | update, 2, 3, 100_000_000)
        with self.assertRaises(ValueError):
            validate_full_import(self.report(), 0, 3, 100_000_000)


if __name__ == '__main__':
    unittest.main()

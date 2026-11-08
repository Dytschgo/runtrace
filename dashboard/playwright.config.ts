import { defineConfig } from '@playwright/test';

// By default the suite builds a synthetic fixture and serves it with a pinned clock (tests/global-setup.ts), so results do
// not depend on real data or the time of day. RUNTRACE_BASE_URL points it at a running service instead.
const live = process.env.RUNTRACE_BASE_URL;
const port = Number(process.env.RUNTRACE_FIXTURE_PORT ?? 4398);

export default defineConfig({
  testDir: './tests',
  outputDir: process.env.RUNTRACE_TEST_OUTPUT ?? 'test-results',
  globalSetup: live ? undefined : './tests/global-setup.ts',
  use: { baseURL: live ?? `http://127.0.0.1:${port}`, headless: true, timezoneId: 'Europe/Zurich' },
  reporter: 'list',
  projects: [
    { name: 'journeys', testIgnore: /frames\.spec\.ts/ },
    // Frame rates measure the machine as much as the page, so they run alone, one at a time, once the journeys are done.
    { name: 'frame-rate', testMatch: /frames\.spec\.ts/, dependencies: ['journeys'], workers: 1 },
  ],
});

import { defineConfig } from '@playwright/test';

// Point RUNTRACE_BASE_URL at an isolated instance to avoid touching the production service.
export default defineConfig({
  testDir: './tests',
  outputDir: process.env.RUNTRACE_TEST_OUTPUT ?? 'test-results',
  use: { baseURL: process.env.RUNTRACE_BASE_URL ?? 'http://127.0.0.1:4310', headless: true },
  reporter: 'list',
});

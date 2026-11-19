// Build and own a neutral fixture for visual review, with the same teardown as E2E.
process.env.RUNTRACE_FIXTURE_PORT = '4397';
const { default: setup } = await import('../tests/global-setup.ts');
const teardown = await setup();
try {
  await import('./visual-review.mjs');
} finally {
  await teardown();
}

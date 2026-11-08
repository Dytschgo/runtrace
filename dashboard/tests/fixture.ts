import { test as base, expect, type BrowserContext } from '@playwright/test';

// The browser tests read a small synthetic history that `t3ui fixture --now <instant>` builds, served with the service's
// clock pinned to that instant (global-setup.ts). Every browser context gets the same instant on its clock, so "now",
// "today" and "the last hour" mean the same thing on every run and at any time of day.
// Set RUNTRACE_BASE_URL to run against a live service instead: the clock is then left alone and the tests that need the
// fixture's known moments skip.

export const LIVE = !!process.env.RUNTRACE_BASE_URL;
export const FIXTURE_NOW = process.env.RUNTRACE_FIXTURE_NOW ?? '2026-11-08T13:37:00.000Z';
/** The instant the tests treat as now, in milliseconds. */
export const NOW = LIVE ? Date.now() : Date.parse(FIXTURE_NOW);

const DAY = 86_400_000;
/** Midnight UTC of the fixture's day, which the fixture counts its days back from (crates/core/src/fixture.rs). */
export const DAY0 = Math.floor(NOW / DAY) * DAY;
/** A moment n days back from DAY0, at hh:mm UTC, as the ISO string the dashboard puts in its links. */
export const day = (n: number, h = 0, m = 0, s = 0, ms = 0) => new Date(DAY0 - n * DAY + ((h * 60 + m) * 60 + s) * 1000 + ms).toISOString();
/** A whole UTC day, n days back, as since/until. */
export const wholeDay = (n: number) => `since=${day(n)}&until=${day(n, 23, 59, 59, 999)}`;

/** Where the fixture puts things, in days back from DAY0 (crates/core/src/fixture.rs). */
export const FIXTURE = {
  /** The first record of all, a session-log hour at 09:00 UTC. */
  historyStart: 148,
  /** Nothing at all from day 121 22:00 to day 105 08:00. */
  gap: [121, 105] as const,
  /** Provider turns start here; before it there are only session-log hours. */
  turnsStart: 88,
  /** Session-log hours stop after this day. */
  logsEnd: 45,
  /** 17:00-21:00 UTC: Opus ran at 18:45 and reported nothing, and Muse reported only token parts. */
  evening: 8,
  /** 00:00-07:00 UTC: at 03:00 only turns that reported nothing ran. */
  silentHour: 21,
  /** A burst of turns that reported nothing, early on this day. */
  burst: 27,
  /** Sonnet did not run on this day. */
  noSonnet: 35,
  /** Delegation happened on this day, none of it by Sonnet. */
  delegationNoSonnet: 29,
  /** 03:15 and 03:30 UTC: the same child delegated to twice. */
  repeatDelegation: 1,
  /** The thread with one turn that reported a total and one that did not. */
  lowerBoundThread: 'Measure the partly reported totals',
  /** A project name in the fixture. */
  project: 'atlas',
};

/** The date the dashboard shows for a moment, in its default timezone. */
export const zurichDay = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', day: 'numeric', month: 'short' }).format(new Date(iso)).toUpperCase();

/** Puts the fixture's instant on a context's clock. Time then runs on from there, so timers and React Query keep working. */
export async function pinClock(context: BrowserContext) {
  if (!LIVE) await context.clock.install({ time: NOW });
}

/** Skips a test that needs one of the fixture's known moments when the suite runs against a live service. */
export const fixtureOnly = () => test.skip(LIVE, 'Needs the synthetic fixture history.');

export const test = base.extend({
  context: async ({ context }, use) => {
    await pinClock(context);
    await use(context);
  },
});
export { expect };

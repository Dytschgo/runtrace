# Quota tracking

Quota is what the coding agents and T3 Code report about their limits. Nothing is estimated: a figure is a reading, and anything worked out from readings, such as a pace, is labelled as a projection.

## Sources

While serving, a separate serial worker reads these sources independently of imports. It waits at most 60 seconds after each completed pass (`poll_seconds`, a minute by default). Standalone collection also reads them. Code: `crates/core/src/quota_sources.rs`.

| Source | Harnesses | What it gives | Stored as `source` |
|---|---|---|---|
| T3 Code's usage cache, `.t3/caches/<harness>.json` | Every harness T3 can ask: Claude Code, Codex, Grok… | Each window's percentage used and reset, reset credits, or why the harness reports nothing | `t3_usage_cache` |
| Runtrace's own checks (below) | Harnesses T3 does not check: Antigravity, Muse | The same, from the harness's own program | `runtrace_check` |
| Codex session logs, `.codex*/sessions/**/*.jsonl` | Codex and its other homes | A reading with every turn, and the plan | `codex_session_log` |
| `~/.claude.json` `cachedUsageUtilization` | Claude Code | Its latest reading of each window | `claude_usage_cache` |
| Claude Code session logs, `~/.claude/projects/**/*.jsonl` | Claude Code | Every refusal for a reached limit, with the window and reset | `claude_session_log` (events) |
| Muse session logs, `~/.local/share/muse/sessions/**/*.jsonl` | Muse | Every refusal for an exhausted subscription, with its reset | `muse_session_log` (events) |

T3 asks each harness for its limits every few minutes and after turns. Its cache folder sits next to the folder that holds its database, so it is found from `source.sqlite_path`.

- A T3 reading is kept when it changed, and otherwise at least every 15 minutes, so a window's readings show it was watched the whole time.
- Claude Code's account is stored as `claude` and every other harness under its T3 name (`codex`, `grok`, `codex-ollama`…), so older history stays one line.
- Windows are named the same whatever the source: `five_hour`, `seven_day`, `seven_day_<model>`, and `weekly` or `daily` from the window's length. A window T3 gives only as weekly is stored as 10,080 minutes.
- Resets reported a few minutes apart are the same reset.
- Nothing about the account, such as its sign-in, is copied from T3's cache.

## Runtrace's own checks

For a harness T3 does not check, Runtrace asks the harness's own program itself, every 5 minutes, the way T3 does. Code: `crates/core/src/quota_checks.rs`.

| Harness | How it is asked | What comes back |
|---|---|---|
| Antigravity | `agy -p /usage --output-format json` | What is left of each model group's weekly limit (Gemini; Claude and GPT) and its reset |
| Muse | `muse serve`, then `initialize` and `usage/refresh` | The subscription tier and, when Meta sends it, the 5-hour and weekly windows |

- A check runs only when the program is installed and T3 reports no windows for that harness.
- Each check has a minute to answer. A check that fails says why on the Quota page.
- Muse's own update launcher is skipped: the newest `muse-bin-*.exe` beside it is run directly.
- Nothing about the sign-in is read; the programs use their own.
- The answers are saved in the `quota:checks` setting. Set `[quota] checks = false` to turn the checks off.
- A limit nobody has used yet has no running reset (Antigravity shows one a full week out that moves with every check), so it is shown as unused and not stored as a reading.

Harnesses with nothing to show are listed under **No limits to show** with the reason:
- A Codex home whose provider is on this machine (Ollama, LM Studio, or a `base_url` on localhost) runs local models and has no limit.
- Muse is subscribed, but Meta sends no usage numbers yet.
- T3 or Runtrace marks a failed check (`probeFailed`) or an unsupported one.

## Live view

Each quota pass also saves T3's whole answer, with Runtrace's own checks, as one snapshot. `quota/live` returns one row per enabled harness, and per disabled harness that still has limits, with these fields:
- `harness`, `quota_key`, `checked_at` (when it was asked), `checked_by` (`t3` or `runtrace`), `read_at` (when Runtrace read it), `plan`
- `windows`
- `credits` (reset credits and their options)
- `unavailable`
- `reports_limits`

On the Quota page everything is shown as **what is left**, not what was used:
- **One card per harness.** Each window shows the percentage left, a bar of what is left, and when it resets. It shows the newer of the check's figure and the agent's own reading.
- **Little left:** a window with 20% or less left is marked, here and in the navigation on every page.
- **Pace:** from recent readings, when the window would run out, or that it lasts until the reset. It is a projection and labelled as one.
- **Freshness:** a dot pings while live (under 10 minutes), dims for older checks and returns to high contrast after an hour with “not checked since” text. All three states use monochrome tones.
- **No live answer:** a harness T3 does not know keeps its stored readings.

## Windows

`quota/windows` has one row per reset. It gives the highest reading, which is at least what was used, and the last reading before the reset, which is at most what was left. The page shows the second as **Left**, marked `≤`.

A finished window is **complete** when readings no more than 20 minutes apart cover it from its start (reset minus length) to its reset, or to the moment it ended early, as after a reset credit. Anything less is **partial**: more may have been used between readings.

Running windows are partial until they end. Past windows from before a source existed cannot be reconstructed.

Every row in `quota/windows` includes `coverage_reasons` and exact `gaps`; complete windows have empty arrays. Missing readings are distinguished from a running window or an unreported window length. The history chart breaks across gaps longer than 20 minutes and across resets, hatches unobserved spans and exposes the interval details; it no longer extends an old reading six hours forward.

The observer reads only paired sleep/wake timestamps from Windows Power-Troubleshooter resume events, at most hourly and over the previous 31 days. Previously recorded pairs are retained when Windows prunes its event log. An overlapping recorded interval is labelled **observer asleep**, with its times. Silence alone is never called sleep. If events were never captured or are inaccessible, the gap says its cause was not recorded. This identifies the observer's sleep, not the work another device might have done.

## Windows warnings

`[quota] notifications = true` is the default. Set it to `false` to disable native warnings independently of quota checks. After quota collection, each fresh, unexpired window warns once at **20% remaining** and once at **5%**. Readings over 20 minutes old are not used for new warnings. `runtrace quota-notify` checks the latest stored readings without collecting source data. `quota/notifications` reports enabled/disabled/unsupported state, display failures and the last check time.

Claims are stored in DuckDB before calling Windows, keyed by provider, window, normalized reset instant and threshold. Restarting cannot repeat the claim. This is at-most-once delivery: a crash between claim and display can lose a warning. Failed or unconfirmed claims remain visible while that window is current and are not retried, preserving the no-repeat rule. Windows policy can suppress notifications; Runtrace reports missing display confirmation rather than claiming success. Platforms other than Windows report unsupported.

The helper uses Windows Forms `NotifyIcon` and waits for `BalloonTipShown`, then keeps the icon alive briefly. Reference: [Microsoft NotifyIcon documentation](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.notifyicon).

`python scripts/verify_quota_notifications.py --exe target/debug/runtrace.exe --native` passed with neutral data in a fresh temporary database: **two Windows display acknowledgements**, thresholds **20 and 5**, config-off and separate-process restart deduplication. The test never opens the installed database. Core regressions also cover exact boundaries, new reset windows, stale/expired/invalid readings and failed delivery. `--native` deliberately displays the two test notifications; omit it to check config-off only.

## Projection check — 2026-11-17

`node scripts/backtest-quota.mjs http://127.0.0.1:4310` in `dashboard/` runs the same `quotaPace` function used by the page on read-only historical API readings. It selects the latest eligible ended window and the latest eligible window with nonzero recent pace, without filtering by forecast error. The first half of observed history supplies training; later readings are held out.

Two real five-hour windows were checked. For the November 17 15:00 UTC reset, 11 training readings predicted 87% remaining at a later reading 99.927 minutes away; the observed figure was 84% (3-point error). For the November 16 17:10 UTC reset, eight training readings predicted 38.076% remaining 106.539 minutes away; the observed figure was 54% (15.924-point error). Both windows are partial. These are comparisons with real later readings, not claims about unobserved use at reset. The second result shows why the pace stays labelled a projection: changed work rates can create material error. More windows are needed to assess general accuracy.

Quota sources do not attribute account windows to individual machines or run statuses. Selecting either global dashboard filter keeps all quota readings, charts and alert state visible, labelled **Installation-wide quota**. Scoped quota API envelopes also state this scope and its reason.


## Current installed-build recheck — 18 November 2026

The installed candidate's neutral notification check again acknowledges two Windows displays at 20% and 5%, config-off and separate-process deduplication. The static executable is copied into a private test directory with a matching DuckDB DLL used only by Python to seed the fixture; the installed service does not require the DLL. Live validation accounts for six harnesses (five numeric, one unavailable), 44 explained partial windows and 487 bounded gaps. There are no recorded asleep causes in this live sample, so it supplies no actual sleep/resume credit. Current real-window holdouts have 4 and 15.924 percentage-point errors; selection is not filtered by accuracy.

Before the Round 30 installation, quota refresh followed the complete import pass. A long initial import can therefore delay readings and warnings beyond the configured poll interval. Round 28 measures all six harness snapshots at 1,627.9 seconds old while HTTP is healthy and import is active. Round 30 fixes this measured scheduling gap with independent sampling; the observation remains as historical failure evidence.


The Round 30 installed build separates serve-time quota refresh from import. The serial worker uses a fresh connection per attempt and a delay of 1–60 seconds after each completed pass; source config validation keeps the normal poll interval at least five seconds. External provider checks and local log scanning still contribute to pass duration. Capture pause continues quota sampling, while `collect_on_serve = false` disables the worker. `health/ready.quota_sampler.last_successful_refresh_at` means the pass completed; inspect each provider's `checked_at`, readings and unavailable reasons for its actual coverage. Round 30 qualifies and installs this worker. Its first live pass completes during an active import, and later live passes advance at the configured cadence.

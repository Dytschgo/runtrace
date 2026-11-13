# Quota tracking

Quota is what the coding agents and T3 Code report about their limits. Nothing is estimated: a figure is a reading, and anything worked out from readings, such as a pace, is labelled as a projection.

## Sources

The collector reads all of these on every sync (`poll_seconds`, a minute by default). Code: `crates/core/src/quota_sources.rs`.

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

Each sync also saves T3's whole answer, with Runtrace's own checks, as one snapshot. `quota/live` returns one row per enabled harness, and per disabled harness that still has limits, with these fields:
- `harness`, `quota_key`, `checked_at` (when it was asked), `checked_by` (`t3` or `runtrace`), `read_at` (when Runtrace read it), `plan`
- `windows`
- `credits` (reset credits and their options)
- `unavailable`
- `reports_limits`

On the Quota page everything is shown as **what is left**, not what was used:
- **One card per harness.** Each window shows the percentage left, a bar of what is left, and when it resets. It shows the newer of the check's figure and the agent's own reading.
- **Little left:** a window with 20% or less left is marked, here and in the navigation on every page.
- **Pace:** from recent readings, when the window would run out, or that it lasts until the reset. It is a projection and labelled as one.
- **Freshness:** a dot shows how fresh T3's check is. It pings while live (under 10 minutes), turns grey up to an hour, and turns amber after that.
- **No live answer:** a harness T3 does not know keeps its stored readings.

## Windows

`quota/windows` has one row per reset. It gives the highest reading, which is at least what was used, and the last reading before the reset, which is at most what was left. The page shows the second as **Left**, marked `≤`.

A finished window is **complete** when readings no more than 20 minutes apart cover it from its start (reset minus length) to its reset, or to the moment it ended early, as after a reset credit. Anything less is **partial**: more may have been used between readings.

Running windows are partial until they end. Past windows from before a source existed cannot be reconstructed.

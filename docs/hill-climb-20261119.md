# Runtrace hill climb â€” 19 November 2026

This continues [Round 25](hill-climb-20261118.md#round-25--real-commit-failure-cleanup-and-replacement-rehearsal) on `runtrace-dashboard`. The carried baseline is **8.40/10**, with the same open acceptance gates. No commit, push, tag, release or final score council has occurred.

| Checkpoint | Reliability (20) | Quota (20) | Storage (20) | Insight (15) | Direct access (10) | Engineering (15) | Weighted total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Carried from Round 25 | 8 | 8 | 8 | 9 | 9 | 9 | 8.40 |
| Round 26: installed candidate and portable recovery | 8 | 8 | 8 | 9 | 9 | 9 | 8.40 |
| Round 27: checksum-preserving legacy archive lookup | 8 | 8 | 8 | 9 | 9 | 9 | 8.40 |
| Round 28: release qualification; live sampling delay found | 8 | 7 | 8 | 9 | 9 | 9 | 8.20 |
| Round 29: independently scheduled quota worker; uninstalled | 8 | 7 | 8 | 9 | 9 | 9 | 8.20 |
| Round 30: qualified and installed independent quota sampling | 8 | 8 | 8 | 9 | 9 | 9 | 8.40 |

## Round 26 â€” installation qualification

The frozen candidate remains `161fc0f85cad6d4fe7b8b87fdac876f8897025dfe4046aeb4b5000f4586b84ea`. Its 117 optimized native, 264 frontend and 189 browser tests, zero-warning clippy, formatting, updater checks and 500 successful randomized API reads are recorded in Round 25. No production source changes are made in this round. The source-input comparison identifies only the reviewed `cold.rs` correction and the already-qualified four-status acceptance fixture against the initial Round 24 input manifest.

Separate Astra Standards and Spec reviews identify defects in the private transition helpers before any executable replacement. They include inconsistent DB/WAL pairing, comparing identities from different canonical database paths, disabled assertions under optimized Python, interrupted recovery, unready process owners, concurrent freezes, late ledger creation and incomplete preservation checks. Follow-up review finds further recovery and fail-closed inventory issues. The root corrects those findings; the final operational adaptations have root verification, rather than a claim of independently executed tests or a zero-finding final Astra review.

The corrected neutral rehearsal passes exact-file rollback, previous-program restart, candidate startup, four API digests and recovery when both the installed stop wrapper and recovery controller fail. Shared exclusive operation locking and rejection of optimized Python pass separate entry-point checks. Five tests execute the actual apply entry point against isolated files with controlled process/HTTP boundaries, including interruption and incomplete recovery. Those tests prove control flow; the native rehearsal separately exercises Windows process termination.

The initial live-copy qualification freezes and verifies the original database/WAL/configuration/program/wrappers/ledger, then restarts the original executable. Public health returns 200. A guard subsequently rejects a copied database because rewriting its cold-file manifest leaves a WAL. Production is already running; no candidate executable is installed. The checker adds an explicit checkpoint and resumes only from the existing hash-verified recovery generation, without another live stop. The rejected report and original checker source are retained.

The final copied-installation check passes: all 192 cold segments, both old/new service starts, four exact API digests and six routes on each service. The interrupted checker process is confirmed absent before its exact lock record is archived; resumption uses the same hash-verified generation and takes no new live snapshot. Two rejected reports and the interrupted attempt remain preserved.

The corrected executable is installed through the reviewed and rehearsed boundary. The fresh freeze includes six original recovery files; only the executable is replaced. The complete transition and verification takes **52.625 seconds**, including backup checksum work. This is not a measurement of HTTP downtime or logon startup. Configuration, all Tailscale handlers and the installed startup command remain unchanged. Eleven API routes each return 200 locally and publicly, and 100 randomized unrelated authorities return 403 (seed 2026111926). Relay port 4311 remains closed. All 630 pre-existing backup files are hash-verified before the new recovery generation is added.

A durable generation under the installed backups directory preserves **207 checksum-verified files**, including the six raw recovery files, 192 cold segments, one legacy event archive, one complete snapshot bundle and a portable database. Only copied metadata is rewritten to refer to these dependencies. Native archive verification confirms all 192 segments and the snapshot/legacy archives; the portable copy starts with disabled collection and unchanged logical statistics. No existing backup is removed or rewritten. Its original raw database/WAL pair is retained separately from the portable database.

The installed supervisor and service run from the expected path, and health reports the identity of the configured database. The first live collector pass is still in progress at the recorded checkpoint: 12 of 37 project scopes completed, with the next importing. Readiness is not substituted for a completed sync report. The new one-shot sign-in observer is registered for the installed executable hash and remains pending. The previous observer's files are retained, and only its exact superseded registration is retired. No sign-out, reboot or sleep is performed.

Scores remain **8 / 8 / 8 / 9 / 9 / 9**, weighted **8.40/10**. Next target is the completed installed collection report and the legacy archive working-directory limitation exposed by qualification. Private operational evidence is under `D:/Scratch/Runtrace/transition-round26-20261119`. Real sign-in remains deferred; actual sleep/resume and the first-import 400 MB gate remain unqualified. Memory tuning stays stopped. Physical cold-file lifecycle and the other published limitations remain open. No 9 is claimed.


## Round 27 — legacy archive verification from another directory

The relative-path failure exposed by Round 26 is reproduced with a neutral native regression. The legacy exporter creates a real Parquet file, and its stored registration is changed to an older relative form while the configured archive directory remains absolute. Verification fails before the fix with a missing-path error. It passes after the correction without changing the registration. The same regression rejects a missing explicit absolute location, damaged bytes and a missing file.

Only a missing relative location permits checking the same filename in the configured archive directory. The original legacy checksum must match. Other I/O failures and explicit absolute locations retain their previous behavior. No database manifest, archive registration or production file is rewritten by this correction.

This is a bounded root review on the Standards and Spec axes, not an independent review or score council. The incremental patch is captured against the previously qualified archive source, rather than attributing the entire older WIP diff to this round. Focused regression: one expected failure before the change, one pass after it. All **118 native tests pass in debug mode**; formatter and clippy with warnings denied pass. The running suite is allowed to finish, including the slower fixture generators, without restarting or suppressing tests. The frontend is unchanged and its suites are not rerun for this narrow backend correction.

The installed executable remains the qualified Round 26 hash. Its collection is advancing through the first pass: 20 of 37 scopes are completed at this checkpoint. No completed-sync claim is made yet. Private evidence is under `D:/Scratch/Runtrace/archive-round27-20261119`: `archive-change.patch`, `source-receipt.json`, `tmp/legacy-{red,green}.log`, native-suite logs and `installed-collection.json`. Scores remain 8/8/8/9/9/9, weighted **8.40/10**. The correction is not installed; fresh release-profile qualification is the next target before replacing the installed artifact again. Real sign-in, sleep/resume, first-import memory and the published cold-file lifecycle limitations remain open.


## Round 28 — release qualification and live quota sampling delay

A release-profile build/test run covers the Round 27 archive lookup correction. The prior frozen installed executable remains running. Frontend inputs match the earlier qualification, and a bounded scan of 34 runtime/migration files has zero forbidden SQL patterns. All **118 native tests pass in release mode**. The frozen executable is `2e52ddbe3bf3890fc43b1c53d6c737de1c117727d67529b6037f0b9050e38a3b`, an uncommitted 0.2.4 WIP artifact, not a published release. The actual CLI harness reproduces failure with the installed executable, verifies the intact archive with the corrected executable, confirms the registration stays unchanged and rejects damaged bytes. The first harness invocation is rejected because its synthetic TOML omits required fields; the corrected complete configuration passes. The original failed log is retained. No new artifact is installed.

The installed collector advances beyond its earlier long project: 22 of 37 scopes are completed at the observed checkpoint. HTTP remains healthy. At 23:46:32 UTC on 18 November, all six harness snapshots have read ages of **1,627.9 seconds**, about 27 minutes. Source inspection shows `refresh_quota` runs after `importer::import` in the same blocking closure. This establishes that quota sampling and warnings can be delayed by a long collection pass. A healthy HTTP response does not establish fresh quota.

Quota is revised from **8 to 7**, with reliability 8, storage 8, insight 9, direct access 9 and engineering 9 unchanged: weighted **8.20/10**. This supersedes the previous 8.40 current rating. The next target is quota sampling while import is busy, which now loses the most weighted points. The user-stopped memory experiments remain stopped, and the real sign-in remains deferred. No 9, score council, commit, push, tag or release is claimed.

Private evidence is under `D:/Scratch/Runtrace/release-round28-20261119`: `source-input-verification.json`, `installed-progress-before.json`, `quota-freshness-during-initial-collection.json` and release command logs. The archive CLI harness uses a neutral scratch database and a real neutral Parquet file; it does not read or modify the production database.


## Round 29 — independent quota sampling during collection

The installed failure is rechecked with an executable assertion: all six harness readings remain too old, with a maximum age of 1,968.5 seconds against a 120-second freshness check. The saved assertion fails before any source change. No installed behavior is claimed fixed in this round.

Serve now starts a serial quota worker on connections independent of the import writer. It samples immediately, then waits at most 60 seconds between completed attempts; a slow external check can extend a pass. Each attempt gets a fresh connection so a failed or panicking refresh cannot leave its transaction active for the next attempt. Standalone collection keeps its prior quota refresh. Disabled serve collection still suppresses the worker, and pausing content capture does not suppress quota sampling. The additive `quota_sampler` health field reports running/ready/retrying state, pass completion, duration and failure category. Pass completion does not establish fresh provider metrics; their timestamps and unavailable reasons remain authoritative.

Quota history, offsets and cold-manifest reads now share a transaction begun before those reads. A single guard commits on success and rolls back error/panic paths, including failures before source scanning. Alert claims still commit before native display and retain existing at-most-once behavior.

### Standards

The independent Astra review finds one low cleanup issue: the first guard attempted rollback after successful commit and duplicated error cleanup. Root fixes it with a disarming commit method and one rollback owner. No blocking concurrency fault is reported. The small correction is root-verified; no independent zero-finding recheck is claimed.

### Spec

A separate Astra review finds no scheduling defect in the captured scope. It distinguishes sampler completion from provider freshness and identifies qualification limits. Root subsequently adds an actual HTTP server test with failed import and production notification configuration disabled. A subsequent focused regression directly covers concurrent cold publication. Restart deduplication and live sampling still require broader integration evidence before installation; earlier core checks are not presented as a new installed pass.

All **18 CLI tests pass**, including real neutral quota readings and both thresholds during an uncommitted concurrent writer, fresh-connection recovery after an error and a worker panic, actual server startup despite import failure, and notifications-off behavior. No OS warning is displayed by these tests. The first focused run catches an integer-versus-floating JSON assertion mismatch; the corrected assertion checks the stored percentage as its declared floating type. Clippy with warnings denied passes. The full **122-test native suite passes**, including early-read transaction cleanup. A subsequently added focused cold-publication regression also passes: quota collection commits through a second connection while Parquet publication remains uncommitted, and the final logical history contains both the archived and fresh readings. This is 122 full-suite passes plus one additional focused pass, not a claim of a single 123-test full run. Final formatting and zero-warning clippy pass.

The source prototype is not installed. The live collector continues on the preserved Round 26 executable and reaches 31 of 37 completed project scopes at the recorded checkpoint. Scores remain **8/7/8/9/9/9**, weighted **8.20/10**. Next target is release/integration qualification of this worker under mixed API and collection load, then a guarded installation with verified live quota progress. No commit, push, tag, release or score council occurs. Real sign-in, the stopped import-memory gate and published lifecycle gaps remain open.

Private evidence: `D:/Scratch/Runtrace/quota-round29-20261119`, including `live-delay-red.json`, captured review files/pins, `review-disposition.json`, focused/CLI logs and `live-state-after-prototype.json`.


## Round 30 — release and live qualification of independent quota sampling

The frozen bundled executable is `39cbbb253bec054fb57ba4ebc4c90bb71782ef0df6f4372b90abed49cd14870a`, an uncommitted 0.2.4 WIP artifact. It passes **123 optimized native tests, 264 frontend tests and 189 browser tests**. Frontend inputs remain unchanged; browser checks cover the existing desktop/phone, axe, overflow and navigation cases. No new manual all-page visual review is claimed. A 35-file runtime/migration scan has zero forbidden SQL-pattern matches.

The seeded mixed-load pass (2026111930) returns **500/500 HTTP 200, zero 503**, four workers and twelve route types: 205.375 s, median 1,250 ms and p95 4,344 ms. Collection advances with 36/36 copied scratch scopes synced, no partial sync and no project errors. Automatic maintenance moves 99 rows in three segments with copy/restore checks true. The quota worker and stored read timestamps advance independently. After request 100, the harness changes a neutral cache from 80% to 95% used; the API observes 95%. The scratch poll interval is five seconds. This copies prior committed history at the ordinary 2,048 MB serving budget. It provides no first-import or 400 MB memory credit, and overlapping browser/update work prevents a controlled speed comparison.

The current-code synthetic version fixture passes real updater replacement, checksum rejection, backup-failure recovery, four API digests, detached cold-backup restore, scripts and standalone execution. It is not the prohibited published historical binary. Crash recovery passes in 4.438 s with stop/backoff/restart and sixteen Host checks. Two actual Windows display acknowledgements cover 20% and 5%, with configuration-off and separate-process restart deduplication. The DLL supplies only the private Python fixture writer; the qualified executable remains standalone. The actual legacy archive CLI check also passes and rejects damaged bytes.

The old installation completes 37/37 scopes before transition. The prior operational flow is adapted to the old/new hashes and rehearsed against a small neutral cold-quota fixture. Exact-file rollback, prior restart, candidate startup and recovery after both stop controllers fail pass. Fresh stopped copies preserve the original DB/WAL/program/configuration/wrappers/ledger. Old and candidate probes start against copied data, all 194 cold segments verify, four API digests match and six routes each return 200. The production configuration and proxy remain untouched during those probes.

The guarded replacement succeeds. Its complete freeze/replacement/check sequence takes **70.266 seconds**, including backup verification; this is not HTTP-downtime or logon timing. A separate observer records the new process while its collector is still **starting**: the quota pass completes in **581 ms**, all six harness snapshots have read ages at most **0.155 s**, and its PID matches the final installed PID. A later pass completes in 709 ms on the configured **60-second cadence**, with all six read ages at most 32.543 s at inspection. These are source-read/pass timings, not a claim that every upstream provider supplies current numbers. Existing provider check times and unavailable reasons remain visible.

Installed collection subsequently reports **37/37 scopes synced**, no partial sync and no project errors. Eleven API routes each pass locally and publicly; 100 randomized unrelated Hosts are rejected. Configuration, all Tailscale handlers and installed startup registration are unchanged; relay port 4311 stays closed. All **839 pre-existing backup files** are verified before adding the new generation. A durable **209-file** recovery generation verifies 194 cold segments, a legacy archive and a snapshot bundle, then starts its portable copy with unchanged logical statistics. No previous backup is removed or rewritten.

The sign-in observer is re-armed for the installed hash. The prior attempt remains preserved and unqualified; the new attempt is pending. No sign-out, reboot or sleep is forced. Source stays at `D:/Code/Runtrace/source`; the protected retired C: live-data junction is untouched. No commit, push, tag, publication or score council occurs.

Quota returns from **7 to 8** for the reproduced scheduling fix and live evidence. Reliability 8, storage 8, insight 9, direct access 9 and engineering 9 remain: weighted **8.40/10**. The known-limitations list removes the fixed import-bound sampling and legacy archive lookup defects. Real logon, actual sleep/resume, the failed first-import ceiling and immutable-file lifecycle limitations remain open. Further memory tuning remains stopped per the user. No 9 is claimed.

Private proof is under `D:/Scratch/Runtrace/release-round30-20261119`: `release-source-receipt.json`, native/frontend/browser logs, updater/supervisor/notification logs, `mixed-load-summary.json`, original mixed-load result, transition/copy/apply reports, `first-live-quota-refresh.json`, `installed-verification.json`, `new-logon-observer.json`, `durable-recovery.json` and `round30-evidence.json`. The durable generation is retained independently under the installed backups directory.


## Acceptance audit after Round 30

The installed hash and all 35 captured runtime/migration source hashes still match qualification. Current local and public health return 200 for the same process; collection is synced across 37 scopes and the independent quota worker is ready. This audit awards no new points. The weighted score remains **8.40** (8/8/8/9/9/9).

| Required evidence | Current finding | Proof / limit |
| --- | --- | --- |
| Real logon or reboot; public 200 within two minutes | **Unqualified** | The current hash-pinned RunOnce registration matches its input; result is still pending. The user defers the new sign-in. Registration and current HTTP 200 do not prove this gate. |
| Automatic crash recovery | Qualified bounded test | Current artifact recovers in 4.438 s; installed supervision and process identity are checked. |
| Dashboard down/stale indication | Qualified UI behavior | Failed/held refresh and freshness cases, with unchanged frontend and passing integrated browser suite. |
| Start, stop and update | Qualified bounded and operational checks | Real wrappers used in live freezes/cutover; updater checksum, backup-failure recovery and scripts pass. |
| Partial quota reasons and visible gaps | Implemented/tested; live sleep check open | Coverage reasons, gap bounds and chart breaks pass; sleep is attributed only to paired recorded events. No actual sleep/resume qualification is claimed. |
| Native 20% / 5% alerts, once per window across restart, config off | Qualified bounded native check | Two Windows display acknowledgements, separate-process deduplication and configuration-off pass on neutral data. Crash between claim and display remains a declared loss window. |
| Projection checked against a real past window | Qualified bounded holdouts | Two recorded holdouts, with 4 and 15.924 percentage-point errors; no general forecast-accuracy claim. |
| Every harness has numbers or a reason | Qualified live/fixture scope | Six live harness snapshots plus unavailable-state coverage. Provider freshness is distinct from the sampler's pass/read timestamp. |
| Quota refresh continues during import | Qualified and installed | Live first pass occurs while collector is starting; later cadence advances. Mixed-load cache change is observed. |
| Automatic 30-day Parquet move and hot/cold equality | Qualified bounded and live checks | Native equality regressions and installed maintenance; current mixed load moves 99 rows in three verified segments. |
| Restore after moving data | Qualified bounded and complete-history checks | Earlier all-column restores plus current 209-file portable recovery and 194 cold segments. |
| Complete first import peaks at or below 400 MB | **Failed** | The saved bounded trial is partial: 27/36 scopes, with native allocation failures. Its 328.339 MB peak is not a completed-import pass. Further tuning is stopped per the user. |
| 500 mixed requests during collection, zero 503 | Qualified current artifact | 500/500 HTTP 200, both collector and quota progress, seeded workload. |
| Performance/compression measurements documented | Qualified for measured scopes | Current timings, memory failures, budgets and limits are recorded in performance-and-compression.md. |
| Agent tree critical path | Qualified selected interpretation | User-selected observed timed chain, explicit coverage; no invented waits or causal dependencies. |
| Global machine/status filters and URL persistence | Qualified bounded scope | Four native run statuses and browser navigation across all pages; installation-wide exceptions are explicitly labelled. |
| Honest efficiency coverage | Qualified bounded scope | Observed tool/turn and retry/thread ratios retain coverage denominators and unknowns. |
| Desktop and phone overflow / axe / own inspection | Qualified frontend; final review remains conditional | Current integrated 189-test browser suite; prior manual captures inspected at both widths, with unchanged frontend inputs. No fresh manual all-page review is claimed in Round 30. |
| Direct Tailscale allowed_hosts and no relay | Qualified installed state | Existing handler points directly at loopback; configuration and other handlers unchanged, port 4311 closed. |
| Localhost-only default and rejection of other Hosts | Qualified bounded/live scope | Default admission tests, sixteen lifecycle Host checks and 100 randomized installed rejections. |
| Formatting and zero-warning clippy | Qualified captured source | Current source matches the formatting/clippy-qualified implementation. |
| Rust, frontend and browser suites | Qualified recorded invocations | 123 optimized native, 264 frontend and 189 browser passes; the earlier debug suite and focused regression are recorded separately. |
| Docs and limitations match delivered changes | Updated, remaining gaps explicit | The two fixed quota/archive defects are removed from current limitations. Immutable-file reclamation/crash-orphan lifecycle and other published capability limits remain. |
| No DuckDB ICU SQL | Qualified inspected scope | Current 35-file scan and reviewed changes; prohibited published historical executable remains retired. |
| Final randomized stress and whole-product council | Stress qualified; council **not eligible** | Mandatory gates are incomplete, so no Opus/Sol/Muse scoring council is requested. |
| No commit/push/release without request; protect live install and private data | Preserved | Source remains on the requested branch/HEAD; qualified local build only, preserved backups and neutral public evidence. |

The real new sign-in and completed 400 MB import are mandatory missing gates, not optional score improvements. Continuing the latter experiment would contradict the user's stop-tuning instruction; forcing the former would contradict the deferred sign-in. No honest 9 can be claimed from repeated serving tests or registration checks. The goal remains incomplete. This is the first blocked-state audit after the successful implementation rounds, not a completed goal or a user-requested pause. No new build, destructive cleanup or unrequested OS transition is performed.

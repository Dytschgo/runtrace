# Runtrace hill climb — 18 November 2026

This continues [the baseline and earlier rounds](hill-climb-20261117.md), on `runtrace-dashboard`. No score reset is intended. The qualified local deployment is recorded in Round 22. No commit, push, tag or score council has occurred. Measurements use copied executables, scratch databases and an immutable source snapshot.

| Checkpoint | Reliability (20) | Quota (20) | Storage (20) | Insight (15) | Direct access (10) | Engineering (15) | Weighted total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Carried from Round 5 | 6 | 8 | 6 | 6 | 8 | 6 | 6.60 |
| Explicit global-metric scope policy verified | 6 | 8 | 6 | 6 | 8 | 6 | 6.60 |
| Round 6: machine-safe tree/token attribution | 6 | 8 | 6 | 7 | 8 | 6 | 6.75 |
| Round 7: observed timed chain and storage review fixes | 6 | 8 | 6 | 8 | 8 | 6 | 6.90 |
| Round 8: ordered, durable batch publication | 6 | 8 | 6 | 8 | 8 | 6 | 6.90 |
| Round 9: shorter source/hash lifetimes; full ceiling still fails | 6 | 8 | 6 | 8 | 8 | 6 | 6.90 |
| Round 10: checkpoint headroom; full ceiling still fails | 6 | 8 | 6 | 8 | 8 | 6 | 6.90 |
| Round 11: rollback ownership and negative allocation experiments | 6 | 8 | 6 | 8 | 8 | 6 | 6.90 |
| Round 12: 4 MiB batches; full ceiling still fails | 6 | 8 | 6 | 8 | 8 | 6 | 6.90 |
| Round 13: release completed source maps; full ceiling still fails | 6 | 8 | 6 | 8 | 8 | 6 | 6.90 |
| Round 14: native lifetime diagnosis | 6 | 8 | 6 | 8 | 8 | 6 | 6.90 |
| Round 15: 112 MB offline candidate; full ceiling still fails | 6 | 8 | 6 | 8 | 8 | 6 | 6.90 |
| Round 16: readable pending totals and selected model rows | 6 | 8 | 6 | 8 | 8 | 6 | 6.90 |
| Round 17: bounded Opus retry fails complete import; retained build passes all suites | 6 | 8 | 6 | 8 | 8 | 8 | 7.20 |
| Round 18: retained-build visual review and harness status coverage | 6 | 8 | 6 | 8 | 8 | 8 | 7.20 |
| Round 19: full-source serving and 500 mixed reads; complete restore pending | 6 | 8 | 7 | 8 | 8 | 8 | 7.40 |
| Round 20: complete stored-value restores and final integration | 6 | 8 | 8 | 8 | 8 | 9 | 7.75 |
| Round 21: verified source migration and build-target paths | 6 | 8 | 8 | 8 | 8 | 9 | 7.75 |
| Round 22: installed supervision, direct HTTPS and logon registration | 8 | 8 | 8 | 8 | 9 | 9 | 8.25 |
| Round 23: failed-publication cleanup and truthful dashboard labels | 8 | 8 | 8 | 8 | 9 | 9 | 8.25 |
| Round 24: fresh release-profile qualification and all four run statuses | 8 | 8 | 8 | 9 | 9 | 9 | 8.40 |
| Round 25: real COMMIT-failure cleanup and replacement rehearsal | 8 | 8 | 8 | 9 | 9 | 9 | 8.40 |

Reliability, quota and storage each lose 0.40 weighted points against a perfect score. A first full-history import under 400 MB has not qualified. Real logon recovery, actual sleep/resume and the conditional Opus/Sol/Muse council remain open. Round 25 qualifies the corrected bundled candidate; it is not installed. Documented unsupported capabilities and physical cold-file reclamation remain in known-limitations.md; no forensic deletion guarantee is made.

## Round 6 — machine and status scope

The user's scope policy keeps unattributable metrics visible with explicit installation-wide labels. Logical record counts follow machine and containing-run status; quota readings, physical storage, local controls and collection reports expose their broader scope. URL filters persist through navigation and reload. Tool-call status remains separate from containing-run status.

Combined-machine trees, thread token totals and navigation now use machine-scoped identities. Duplicate-source-ID regressions and browser fixtures verify separate 121/909 token totals and prevent child links from crossing machines. The prior report contains the original scope implementation and evidence.

Insight rose from 6 to 7. Other scores remained unchanged: 6.75 weighted.

## Round 7 — observed critical path and storage review

The user's selected interpretation is implemented: highlight the longest observed timed delegation chain, label coverage, and never infer parent waits or dependencies between siblings. Nested intervals count once; repeated spans, equal longest paths and missing-time lower bounds have four new unit regressions. The partial fixture shows one of two agents fully timed. Both widths were inspected.

At this checkpoint the dashboard passed 264 unit tests, 173 browser tests and a production build. The browser suite covers all thirteen navigation pages at 1280/390, axe, document overflow, filter persistence and actual navigation hit targets. Logs: `runtrace-palette-final-units.log`, `runtrace-palette-final-e2e.log`. Later captures and suites below supersede the transient capture locations.

### Standards

An independent Astra 6.2 Standards review pinned WIP at HEAD `4a3f975ddae411951978dfa44e290f0a2ae24224`, including hashed untracked files. It found correction/purge resurrection, repeated-payload event rewriting, working-directory-dependent manifest paths and false benchmark qualification. Follow-up findings covered archive verification after purge and visibility of older event metadata. Root reproduced the triggers, fixed them and obtained bounded hashed rechecks. The reviewer did not run benchmarks.

### Spec

A separate Astra 6.2 Spec review found correction/purge resurrection, expired content after restore, false benchmark qualification and stale performance evidence. Its follow-up independently found verification after purge. Rechecks accepted the reproduced fixes. Standards rated the qualifier finding P2; Spec rated it P1. That disagreement is retained. These reviews are not the score council.

Purge writes durable record identities before deletion, suppresses old record/event attribution and prevents importer reattribution. Physical indexes remain available to detect corruption. Regressions verify/export after purge, restore snapshots from both sides of purge, reject reimport and deliberately damage an index in a rolled-back transaction. Legacy scope-only ledgers cannot reconstruct missing historical identity mappings.

Restore applies current content retention before facts/search hydration. A reproduced numeric row-ID gap near 2^62 is handled by selecting actual pending rows. New segment paths are absolute; relative manifests are reanchored only with checksum evidence. Repeated payload events retain original observation metadata.

The integrated native suite passed 101 tests and zero-warning clippy. Logs include `runtrace-astra-review-red.log`, `runtrace-astra-expiry-red.log`, `runtrace-astra-review-green.log`, `runtrace-astra-purge-verify-red.log`, `runtrace-astra-purge-events-red.log`, `runtrace-astra-purge-verify-green.log`, `runtrace-astra-final-all-tests.log`, `runtrace-astra-final-clippy.log`.

Insight earned 8. Reliability 6, quota 8, storage 6, direct access 8 and engineering 6 remained unchanged: 6.90 weighted. Full-history memory and mixed requests remained open.

## Round 8 — ordered, durable offline publication

Earlier small recent batches committed at 1,000 rows but remained hot unless they reached the byte threshold or age eligibility. Offline backfill now publishes every committed batch's exact identities, including its final tail, while preserving unrelated hot rows. Normal collection retains hourly age-based maintenance.

A 1,005-small-output regression reproduced the retained-hot-row problem. A wider source with 100,000 one-kilobyte outputs and 128-character identities then exposed a selected-copy ordering failure. The strengthened 3,005-output test first reproduced a partial import, then passed every output byte after explicitly ordering the copy by physical row ID. Logs: `runtrace-small-recent-red.log`, `runtrace-small-100k-all-batches-debug.log`, `runtrace-small-copy-order-red.log`, `runtrace-small-copy-order-green.log`.

Both Astra axes found a P2 retry boundary: committed identities were volatile, so a failed spill could be skipped as unchanged on retry. Pending IDs now commit in settings with their hot rows and resume before revision skipping. Full offline import drains every queue for the source instance, including thread-limited imports and projects absent from discovery. Another instance's queue is excluded. Acknowledgement follows verified publication; replay does not create duplicate files. Logs: `runtrace-pending-spill-red.log`, `runtrace-pending-spill-green.log`, `runtrace-pending-scope-red.log`, `runtrace-pending-scope-green.log`.

The final queue format is instance/project scoped. An intermediate format existed only in undeployed scratch experiments and is not migrated. Pause, dry-run and ordinary collection do not start offline replay. Both review axes accepted current-format recovery.

| Neutral 100,000-output run | Peak working set | Peak private commit | Elapsed |
| --- | ---: | ---: | ---: |
| Control | 258,650,112 | 247,894,016 | 917.922 s |
| Ordered durable publication | 284,508,160 | 266,452,992 | 952.906 s |

Both completed 100,004 records. The candidate regressed on this source; no memory or speed gain is claimed. They overlapped other checks. The 100,000 tool identity/payload fingerprint matches: `dcc84efe960233bb16e681394f26f5b688b5e6ca3b9ded6b3f6733df57b431f2`.

Control executable: `e85f2d8e5ae7c34e7f16221857715f04269341eb86ead70ee7556fde09b024f0`. Candidate: `19ee86fc682ecd82fe477da9ee2a42f4f996c78d86d79d0b9544805131c18abc`. Logs: `runtrace-small-100k-control.log`, `runtrace-small-100k-ordered-pending.log`.

The corresponding full frozen source was stopped at 403,390,464 working-set bytes / 385,900,544 private-commit bytes after 910.609 s, before mixed requests. A recovered diagnostic copy contains 908 hot records, 79,790 cold records, 503 segments and 908 pending identities; progress records 20/36 projects complete. These are aggregate checkpoint facts, not an import pass. Log: `runtrace-full-ordered-pending.log`.

The aborted driver previously echoed configured 2048 MB / four-worker arguments as effective defaults. It now distinguishes configuration from unknown effective values when the terminated process cannot report them. Code in this binary defaults to 128 MB / one worker. The qualifier rejects partial/erroring projects, missing completion fields, source-count mismatches, missing peaks and peaks above 400,000,000 bytes. Six Python regressions pass.

At round end, 103 native tests and clippy passed, with 264 dashboard units / 173 browser tests. Four inactive failed experiment data/archive directories were removed after owner/path checks, preserving logs, binaries and frozen source; removed generated bytes were 2,579,662,551. Score stayed 6.90; storage remained next.

## Round 9 — source and canonical-hash lifetimes

Structured payload handling now releases raw JSON after parsing, cloned input after privacy protection and parsed payload before persistence. Only the payload's own ID/update/start fields survive. Projection IDs/timestamps still key revision caches. The metadata-distinction regression deliberately makes those sources disagree and passes before/after.

The canonical hash clone has its own scope. Persistence serialization occurs only after the unchanged-hash return. Three interleaved runs per stage use sixteen neutral 5 MiB outputs and complete the same 20 records:

| Stage | Working-set peaks | Median working set | Median private commit |
| --- | --- | ---: | ---: |
| Held source | 219,684,864; 217,255,936; 220,798,976 | 219,684,864 | 251,351,040 |
| Released source | 200,892,416; 202,416,128; 201,768,960 | 201,768,960 | 235,560,960 |
| New source-only control | 201,834,496; 202,747,904; 201,142,272 | 201,834,496 | 235,044,864 |
| Scoped canonical clone | 196,730,880; 196,878,336; 197,058,560 | 196,878,336 | 229,855,232 |

Times vary; no throughput ratio is claimed. Logs: `runtrace-wide-paired-{1..6}-{control|drop}.log`, `runtrace-wide-hashpaired-{1..6}-{source|hash}.log`.

Hashes: held `19ee86fc682ecd82fe477da9ee2a42f4f996c78d86d79d0b9544805131c18abc`; released source `188636c36726d4dd6461c89fc214fee96b486c41ac1d2116f1c0736933035e4f`; scoped clone `b66e16887e929d3ff26bd5f47f8e068cb4b00c862737aa2c607cbf63a8c85f59`. Across all three, the 20-record identity/payload fingerprint is `477952c6b853d8ed72ca3be3dbe5ed2500501ce61d5e574f33c57a653831126c`, and the 20-event fingerprint is `29e7b580f9ff127d3857191b2f1f522af9f51b24f6d1394f576258b9b1f060d1`. Exact-content regressions remain separate from these fingerprints.

Both Astra axes accepted the bounded lifetime changes without a concrete regression. Native integration passed 104 tests and zero-warning clippy. The full candidate nevertheless failed: 400,232,448 working-set bytes / 387,117,056 private-commit bytes after 1,714.515 s. It did not complete or reach mixed requests. Log: `runtrace-full-released-lifetimes.log`.

The browser rerun also caught a real contrast boundary during the row entrance fade. The failed run had 171 passes, one failure and one dependent test not run. A deterministic test pauses the actual animation at 5%; the corrected rise keyframe moves without fading text. The rebuilt suite passes 175 browser tests, including both widths. Logs: `runtrace-lifetime-final-e2e.log`, `runtrace-entrance-contrast-red.log`, `runtrace-readable-rise-final-e2e.log`. Dashboard units remain 264. Score stayed 6.90.

## Round 10 — exact comparison and checkpoint diagnosis

The selected-row verifier compares borrowed Arrow VARCHAR/null values in lockstep rather than collecting two vectors of strings. Tests cover multiple pages, null versus empty text, UTF-8, altered late fields and transaction-local row-ID gaps. Canonical SHA serialization now streams identical JSON bytes into SHA-256; fixed legacy goldens cover Unicode, encryption-presence rules and scalar roots. These changes did not demonstrate a further whole-process peak reduction on the wide fixture. Logs: `runtrace-wide-comparepaired-{1..6}-{held|stream}.log`, `runtrace-wide-borrowpaired-{1..6}-{owned|borrow}.log`.

Direct search binding also showed no gain: median working set 196,308,992 bytes for native JSON extraction versus 196,714,496 for direct binding. Astra Spec then identified numeric formatting drift. Three exponent-valued cases reproduce mismatches against the bundled engine. Direct binding was removed, restoring native extraction. Expanded parity and forced-hydration equality pass. Logs: `runtrace-wide-searchpaired-{1..6}-{json|direct}.log`, `runtrace-search-exponent-red.log`, `runtrace-search-exponent-green.log`, `runtrace-search-hydration-green.log`.

The pre/post-revert integrated suites pass 107 native tests, formatter, zero-warning clippy and six qualifier tests. Logs: `runtrace-streamed-all-tests.log`, `runtrace-search-reverted-all-tests.log`, `runtrace-streamed-clippy.log`, `runtrace-streamed-qualifier-tests.log`.

### Checkpoint experiment

Actual bundled-engine probes show stable post-drop private memory over 200 fixed-row copy/read cycles, with reused or unique filenames. They do not establish a cumulative filename leak. The ancillary SDK DLL is a separate engine and is not loaded by the statically bundled executable. An SDK-recovered disposable copy failed index deletion and is excluded from actual-engine comparisons.

A new actual-engine replay from a disposable failed checkpoint completes four more batches in 30.156 s at 286,126,080 working-set bytes / 275,021,824 private-commit bytes. Reopening changes database and allocator state; it supports a lifetime effect without identifying a leak.

Three equivalent copies, deterministic diagnostic thread order and four warm batches separate the interventions before the identical fifth batch:

| Intervention | Next-batch max current working set | Next-batch max current private commit | Entire replay peak working set |
| --- | ---: | ---: | ---: |
| None | 269,651,968 | 257,716,224 | 285,011,968 |
| Statement-cache flush | 270,974,976 | 260,222,976 | 287,928,320 |
| Ordinary checkpoint | 211,779,584 | 204,881,920 | 293,646,336 |

Checkpointing provides next-batch headroom; its entire replay peak is higher. A separate boundary probe shows no change from cache flush, followed by private memory falling from 259,588,096 to 166,133,760 and ART bytes from 52,690,944 to 524,288 after checkpoint. Logs: `runtrace-phase-replay-native.log`, `runtrace-phase-replay-flush.log`, `runtrace-phase-next-{control,cache,checkpoint}.log`. Diagnostic hash: `6bef91176bb4ffa953b2e83ee19005c02f07e73eb1f05e1936e0e32a13dd6745`. Instrumentation and deterministic ordering are confined to a disposable clone.

Astra Standards confirmed checkpoint placement outside the import transaction after durable publication/acknowledgement, and requested explicit failure context. The production offline path now does that. Ordinary collection does not adopt this checkpoint policy.

The full per-batch-checkpoint candidate failed at 406,650,880 working-set bytes / 401,072,128 private-commit bytes after 2,476.328 s. It wrote no complete report; no mixed-request stage ran. Hash: `1f8755a2f74042a2ada8bd72bfb2ce97a8f9fd88dc8fe8c100811490be312bf7`. Log: `runtrace-full-checkpointed-batches.log`.

### Current dashboard and operations evidence

The checkpoint-integrated suite passes 107 native tests, zero-warning clippy, 264 dashboard units and 175 browser tests. Logs: `runtrace-checkpoint-all-tests.log`, `runtrace-checkpoint-clippy.log`, `runtrace-checkpoint-ui-tests.log`, `runtrace-checkpoint-e2e.log`.

Supervisor qualification passes crash recovery in 4.453 s, database identity, idempotent start, intentional stop, restart, stop during backoff and 16 Host checks (`runtrace-checkpoint-supervisor.log`). The initial standalone updater passes in 16.453 s with four API digests and verified cold data, but its backup proof still depended on original cold paths; stronger checks below supersede it.

All thirteen navigation pages were inspected at 1280/390. Two provenance explanations were corrected: Models' fallback chart groups matching threads by configured model, while its ledger groups matching runs/turns by requested model; Harnesses' installation-wide limits are distinct from shares computed from filtered activity. The selected interval can omit part of the comparison interval. Astra traced these inputs; no filter leak is claimed.

The scope-copy build passes 264 units / 175 browser tests. The affected pages and partial critical-path view were re-inspected at both widths. Twenty-eight neutral captures and their SHA manifest remain in `target/evidence/scope-final-20261118/`. Logs: `runtrace-scope-copy-ui-tests.log`, `runtrace-scope-copy-e2e.log`. Asset-build hash: `a628fb33b655987bffe78f4a8f0cd3f460612ad606ebad454c70af92ed7631d8`. This asset-only change leaves the full candidate's import code unchanged. Score stayed 6.90; storage remained next.

## Round 11 — rollback ownership and negative experiments

Physical cold-file reclamation is broader than the explicit Storage 9 criteria. The existing contract documents logical expiry/purge and retained immutable bytes. No physical reclamation was added. Astra nevertheless identified a concrete ownership issue: updater rollback databases referenced the installation's original cold paths.

The expanded updater first fails with the original scratch archive unavailable (`runtrace-backup-cold-ownership-red.log`). New rollback copies contain checksummed cold segments and a rewritten copied manifest. Restoring a database file can make it reference a rollback directory; rotation now pins every older directory referenced by the active manifest.

Standards rated backup-failure availability P1; Spec rated it P2. Both severities are retained. A blocked backup path reproduces a refused readiness connection (`runtrace-backup-failure-recovery-red.log`). A previously running service now restarts before the backup error returns; both causes remain available if restart fails too.

The custom-filename WAL bug is reproduced with a real child-process exit. The old suffix rule loses the committed probe table; appending `.wal` to the complete filename recovers 42. Log: `runtrace-custom-wal-red.log`.

### Final rollback policy and tests

- Copied databases and WALs live under `database/`, away from completion markers and cold files.
- Generation creation is exclusive, with bounded collision retries. Target directory components use parsed numeric versions.
- Completion metadata is parsed and validated. Incomplete attempts and unmarked legacy directories are not automatically pruned.
- Rotation keeps the new completed generation, its completed predecessor and every older directory referenced by the active database.
- Copied files are flushed through write-access handles. Unix directory barriers cover legacy and current layouts through a common finalizer. The legacy path explicitly checkpoints too.

Microsoft does not document a same-volume marker rename as a barrier for every sibling file. Standards therefore recommended retaining the completed predecessor on Windows. No power-loss simulation or broader portable rollback-copy guarantee is claimed. Keep a referenced rollback directory in place; archive snapshots provide portable restores.

Meaningful regressions cover restore to the normal database path followed by three more backup rotations, a missing segment that cannot retire the predecessor, an incomplete attempt that cannot replace it, and unavailable original archive files. A fixed target/timestamp test makes two copies for each reserved database basename and reads 42 from both. Deliberately reverting exclusive allocation causes the red attempt to encounter the existing database subdirectory; no overwritten-copy measurement is claimed from that particular red attempt. Legacy recovery also succeeds after the original database is unavailable.

The final native workspace passes 111 tests (15 CLI, 23 core, 73 acceptance), formatter and zero-warning clippy. Logs: `runtrace-backup-final-all-tests.log`, `runtrace-backup-final-clippy.log`, `runtrace-backup-final-focused-tests.log`.

The final standalone updater cycle against a fresh temporary 99.0.6 fixture passes in 21.765 s: backup-failure restart, checksum rejection, replacement, database identity, four unchanged API digests served from the backup while the original archive is unavailable, two cold segments, no loaded DuckDB DLL and final start/stop. Log: `runtrace-backup-final-update.log`. A failed fixture preservation check caused by overlapping the main build was rerun sequentially and is not acceptance evidence.

### Negative allocation experiments

Windows heap optimization succeeds in 681/721 microseconds. With unchanged DuckDB tags, private bytes fall 165,511,168 to 154,247,168 and 164,265,984 to 154,644,480. Idle controls do not change. Next-batch private peaks are 288,772,096 / 280,485,888 in controls versus 288,788,480 / 287,485,952 in treatments: no reliable peak improvement. No production heap call was added. Logs: `runtrace-late-heap-{1..4}-{control|heap}.log`.

The 96 MB late replay fails at its first spill despite a 256,720,896 working-set / 253,157,376 private-commit peak. Before spilling, native ART uses 69,992,448 bytes, overflow strings 11,272,192 and in-memory state 6,294,512. Log: `runtrace-late-checkpoint-budget96.log`. The 128 MB / one-worker defaults remain.

An isolated actual-engine index comparison uses identical 201,761 revision rows and insertion order, 128 MB / one-worker insertion and separately budgeted equality validation. Resident ART bytes are 15,728,640 for the composite key, 25,165,824 for hex digests and 16,252,928 for binary digests; each baseline is 2,359,296. Every arm passes four-field bidirectional equality and a cardinality-preserving upsert. Digest keys do not establish a memory improvement. No schema change was made. Validation's higher peak is not an import result. Logs: `runtrace-revision-index-{composite,hex,blob}.log`.

Attempt payloads total 12,963,364 bytes over 14,663 rows, largest 1,231 bytes; they do not explain the process peak. Scores remain reliability 6, quota 8, storage 6, insight 8, direct access 8, engineering 6: 6.90. Storage remains next.

## Round 12 — smaller retained-content batches

The disposable 4 MiB candidate retains the 1,000-row limit, 128 MB budget and one worker. The fixed neutral source has sixteen 5 MiB outputs. Three interleaved runs per side complete all 20 records and exact source counts.

| Batch threshold | Working-set peaks | Median working set | Private-commit peaks | Median private commit |
| --- | --- | ---: | --- | ---: |
| 8 MiB | 169,361,408; 171,704,320; 171,814,912 | 171,704,320 | 198,836,224; 198,787,072; 198,897,664 | 198,836,224 |
| 4 MiB | 160,534,528; 159,481,856; 159,600,640 | 159,600,640 | 191,885,312; 191,131,648; 191,508,480 | 191,508,480 |

Hashes: 8 MiB `59c090880f2e9e115000230200daca84e5cea3bb120340f1e4f90953ea248a4d`; disposable 4 MiB `3cdf8f493a0902e5fb797d296e3155e67de0a726717cdcdc897ea5b58d6b8b1c`. Logs: `runtrace-batch-size-{1..6}-{eight|four}.log`. No speed or full-history gain follows from these short runs.

The checkout now uses 4 MiB. All three offline regressions pass, including exact content, ordered batches and restart-safe publication. The final current workspace also passes all 111 native tests and zero-warning clippy (`runtrace-batch4-all-tests.log`, `runtrace-batch4-clippy.log`).

The full candidate fails at 400,973,824 working-set bytes / 387,731,456 private-commit bytes after 2,022.641 s. The driver stops its owned process at the unchanged 400,000,000-byte ceiling. It does not finish or reach mixed requests. Hash: `d5088d2a34ff2bbc633078b44eccf5ca85ec1d3199b2a79a0da8c93e08d52dfa`; seed 2026111813; CLI defaults 128 MB / one worker. Log: `runtrace-full-batch4.log`. No full-history memory credit is awarded. Scores remain 6/8/6/8/8/6, weighted 6.90; storage remains next.

Astra's bounded read-only review identifies two maps retained beyond their last reads: lineage metadata after the thread loop, and attempt payloads after the run loop. Their contribution to the peak is still a hypothesis. An actual bundled-engine scratch replay compares explicit release with unchanged lifetimes; it does not modify the full-import executable or the live installation.

Ten inactive derivative phase data/archive directories were removed after checking resolved temporary paths, reparse points and process owners. Free space increased from 3,783,987,200 to 7,922,298,880 bytes. Original checkpoints, frozen input, binaries, logs and metrics remain.

Read-only operations preflight finds a persistent live relay script and no Runtrace logon registration. Windows reports no paired sleep events in the last 31 days; no actual sleep/resume credit is claimed. The live service remains ready/synced on its original PID.

## Round 13 — release completed source maps

Astra's source review confirms that `all` has its final reader in the thread loop and `attempts` in the run loop. Later revisions, spill recovery and checkpoints do not read either map. The source maps contain 4,583 lineage entries / 1,271,276 serialized bytes and 3,624 attempt groups / 3,319,381 serialized bytes in this late-project replay. Streaming byte counts avoid constructing an additional serialized string.

Four sequential actual bundled-engine replays use equivalent copies of the same failed checkpoint, deterministic selected-thread traversal and five subsequent published batches. Only the diagnostic treatment drops the maps after their final readers. Production traversal is unchanged.

| Run | Lifetimes | Peak working set | Peak private commit | Seconds |
| --- | --- | ---: | ---: | ---: |
| 1 | Retain | 308,133,888 | 291,590,144 | 34.718 |
| 2 | Release | 280,940,544 | 273,817,600 | 34.282 |
| 3 | Release | 281,059,328 | 272,728,064 | 34.563 |
| 4 | Retain | 297,488,384 | 295,514,112 | 35.016 |

In the first treatment, releasing lineage lowers current private bytes from 128,049,152 to 107,192,320; releasing attempts lowers 107,778,048 to 102,236,160. Native DuckDB tags are unchanged at these boundaries. Both paired comparisons reduce the whole replay peak; this does not prove a first-full-import pass or a speed improvement. Logs: `runtrace-map-release-{1..4}-{control|drop-maps}.log`. Diagnostic binary: `ea6e393229d68068fa076dd66ce5810bec46e39987134e85003342c6c6570ca5`.

The checkout now releases both maps at those boundaries. Astra's bounded review finds no semantic or error-path change. Formatter, all 111 native tests and zero-warning clippy pass; release builds in 40.77 s. Logs: `runtrace-map-final-{fmt,all-tests,clippy,release-build}.log`.

The rebuilt candidate also passes scratch crash recovery in 3.828 s, idempotent start, intentional stop, restart, stop during backoff, database identity and all 16 Host checks (`runtrace-map-final-supervisor.log`). A fresh temporary 99.0.11 standalone updater cycle passes in 21.609 s, including checksum rejection, backup-failure restart, four API digests, unavailable original cold files, preserved database, no DuckDB DLL and post-update start/stop (`runtrace-map-final-update.log`). Temporary versions remain unpublished.

Its fresh full import fails at 400,023,552 working-set bytes / 383,991,808 private-commit bytes after 1,672.094 s, before completion or mixed requests. Seed 2026111814, default 128 MB / one worker and the unchanged 400,000,000-byte abort threshold (`runtrace-full-released-maps.log`). Binary: `cb870381b9a589179a71b91a6af77d99a3f926cd0dc7464551150cb5b9f5c988`. At launch the host reports 64,642,196 KiB visible memory / 23,615,128 KiB free; no working-set trimming call is used. The existing live collector and bounded scratch qualification/build activity run concurrently, so no isolated speed comparison is claimed. Scores remain 6/8/6/8/8/6, weighted 6.90; storage remains next.

All 28 retained manual captures still match their manifest hashes. Eight inactive A/B data/archive directories were removed after resolved-path, reparse-point and process-owner checks; their result files, phase samples, copied binaries and external logs remain. Original checkpoints and frozen input remain available. The live service still answers 200 with its original PID and synced collector.

An aggregate-only immutable source scan measures the largest provider-turn payload at 1,906 bytes and turn-item payload at 5,370,165 bytes. Thread/run/message maxima are 214,315 / 2,345 / 101,548 bytes. This does not identify the peak's phase, but there is no giant individual provider-turn document behind the retained source clone hypothesis. These figures disclose no source identities or content. Development and quota documentation were corrected to describe the installer stop behavior and current monochrome freshness states.

### Thread-source streaming experiment

A disposable candidate builds global lineage metadata and selected full thread values during the source scan, avoiding the intermediate vector of every full payload. Astra confirms equivalent selection only if parsed payload `projectId` remains distinct from the SQL column used to classify malformed foreign rows, limits count matching rows before duplicate-ID collection, and all rows are parsed even after the limit. No production source change is made.

Four actual-engine five-batch replays in retain/stream/stream/retain order peak at 291,491,840 / 286,838,784 / 290,078,720 / 283,979,776 working-set bytes, and 275,300,352 / 280,944,640 / 281,792,512 / 278,794,240 private bytes. Streaming lowers current private memory after source preparation to 85,602,304 / 86,183,936 versus 113,225,728 / 113,717,248, but does not establish a lower whole-process peak. The canonical global-lineage and selected-thread hashes agree in all four arms. Logs: `runtrace-thread-stream-{1..4}-{control|stream-threads}.log`; diagnostic binary `fb37564b85b93bbb749257e41da67e2cee16cc69f5875043a9812128132995fa`. No full-import claim or adoption follows.

## Round 14 — native lifetime diagnosis

The attached-catalog control reproduces the direct-open replay's approximate pressure. Both arms warm four batches and flush prepared statements after publication, acknowledgement and checkpoint. The control switches away and back; treatment detaches and reattaches the same file before the identical fifth batch. Active-catalog, persistent-table placement, absence of a temporary restore probe and both Rust time UDFs are asserted.

| Run | Catalog action | Fifth-batch max current working set | Fifth-batch max current private commit | Whole five-batch peak working set |
| --- | --- | ---: | ---: | ---: |
| 1 | Retain | 283,095,040 | 263,376,896 | 286,883,840 |
| 2 | Detach/reattach | 279,769,088 | 272,003,072 | 281,341,952 |
| 3 | Detach/reattach | 280,817,664 | 270,868,480 | 281,047,040 |
| 4 | Retain | 279,097,344 | 270,811,136 | 284,647,424 |

Treatment immediately releases private bytes from 176,590,848 to 123,650,048 and 172,019,712 to 118,075,392. Tagged base-table bytes fall from 41,680,896 to 262,144, then return to 39,845,888 after the fifth batch. That immediate release does not produce a reliable resumed-work peak reduction. No production catalog change is adopted.

Each arm ends with 204,219 cold record keys, 204,219 cold event keys and no hot rows. Streaming, order-independent identity/payload-hash inventory digests match across all four arms. They are a diagnostic parity check, distinct from the full-column cold eviction regressions. Five-batch peaks are sampled before the inventory validation; setup/detach remain included. Logs: `runtrace-catalog-reset-{1..4}-{control|detach}.log`; binary `56350187976abb7a14319b2833a5b58225a3ad6fb2ac2167018558406a12123a`.

Astra's next bounded discriminator crosses the entire database-instance lifetime in the same process. Both arms return at an acknowledged chunk boundary and unwind source frames; only treatment drops and reopens the sole Store. Reopening includes initialization, purge handling and hydration, so any benefit would apply to the complete reopen sequence. Setup must preserve 128 MB, one worker and uncompressed writes, and count its own peak. No production change or score increase follows before that experiment.

The same-process comparison completes four warm and four resumed batches, with a diagnostic stop intercepted before project error/backoff handling. The source frame is unwound in both arms. Treatment drops the sole Store, opens the file again and reapplies one worker/uncompressed writes. All four key inventories agree: 204,763 cold record keys and 204,763 cold event keys, no hot rows.

| Run | Connection | Resumed-work max working set | Resumed-work max private commit | Whole eight-batch peak working set | Whole peak private commit |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Retain | 306,380,800 | 295,473,152 | 310,046,720 | 298,643,456 |
| 2 | Reopen | 290,942,976 | 281,989,120 | 293,396,480 | 285,900,800 |
| 3 | Reopen | 284,381,184 | 278,196,224 | 288,014,336 | 279,719,936 |
| 4 | Retain | 291,069,952 | 284,106,752 | 297,586,688 | 290,787,328 |

Each run takes 42.875–43.406 s. Setup and reopening are included in lifetime peaks; source re-preparation is included in resumed work. Logs: `runtrace-instance-reset-{1..4}-{control|reopen}.log`; diagnostic binary `3806edeefe39f5ea2629241131789e4f565e11060a922e8543ef355c3b41da75`. This supports a bounded reopen-sequence benefit at roughly 300 MB pressure, not a full-import pass.

The impact review defers production reopening. A project-only boundary differs from the measured within-project boundary, and operation-wide exclusivity does not currently survive releasing the native lock. Other app writers do not all share a maintenance lease; path-based identity cannot detect replacement at the same path. Those are risks of the proposal, not newly introduced behavior. The current code keeps continuous database ownership. Scores stay 6/8/6/8/8/6, weighted 6.90; storage remains next.

## Round 15 — 112 MB offline candidate

The simpler budget comparison retains the same Store throughout both chunks. Two 112 MB / one-worker replays complete all eight batches at 284,246,016 / 278,196,224 working-set bytes and 276,234,240 / 274,739,200 private bytes. A new interleaved 128 MB control peaks at 303,087,616 / 294,469,632; the prior two 128 MB controls peak at 310,046,720 / 298,643,456 and 297,586,688 / 290,787,328. The first 112 MB inventory matches the controls; this is resumed, deterministic diagnostic traversal, not full-history qualification. Logs: `runtrace-instance-budget112.log`, `runtrace-instance-budget128-control.log`, `runtrace-instance-budget112-repeat.log`.

The checkout now caps the default offline backfill budget at 112 MB. Lower configured limits and explicit overrides are preserved. `import --verify` keeps its prior 128 MB default. Serving and collection budgets are unchanged. Formatter, 111 native tests and zero-warning clippy pass; release builds in 28.31 s. Logs: `runtrace-budget112-final-{fmt,all-tests,clippy,release-build}.log`.

The real CLI default completes two neutral sources with 20 / 68 changed records at 93,052,928 / 103,215,104 working-set bytes and 94,248,960 / 97,308,672 private bytes. Both report effective 112 MB / one worker, all expected projects/threads and no partial sync. Logs: `runtrace-budget112-wide16.log`, `runtrace-budget112-wide64.log`. Their output sizes are not inferred from pointer filenames.

The fresh full candidate fails at 401,559,552 working-set bytes / 383,594,496 private bytes after 3,272.297 s. It is stopped before completion and sends no mixed requests. Seed 2026111815, default settings and the unchanged 400,000,000-byte abort threshold (`runtrace-full-budget112.log`). Binary `2f72c6c0fc88dc30daba401c6e102a22cd4b9d006943a77785a8e2b3839beae6`. Scores remain 6/8/6/8/8/6, weighted 6.90; storage remains unqualified. The live installation is unchanged.

The same candidate passes 264 dashboard units and all 175 browser tests (`runtrace-budget112-final-ui-tests.log`, `runtrace-budget112-final-e2e.log`). A new explicit neutral source with sixteen 5 MiB outputs completes all 20 normalized records at 160,866,304 working-set bytes / 192,229,376 private bytes in 5.609 s. A separate full-content API check confirms all sixteen serialized structured values, including each complete output, match the expected neutral source (`runtrace-budget112-five-mib.log`, `runtrace-budget112-five-mib-bytes.log`). These are bounded checks, not a full-history pass.

A separate post-eviction scratch copy fails its 30-minute initial collector-readiness deadline before sending the 500 requests. It was making durable progress and health returned 200; no 503 or data corruption was observed. An earlier harness mistake involving Windows short/long path aliases was stopped and corrected with parsed TOML path assertions. No live path or port was used. Log: `runtrace-large-cold-existing-stress.log`.

The user directs one Opus 5.5 attempt after a failed qualification, then retention of the best tested candidate and continuation of other scorecard work if that attempt also fails. The selected Claude model is `claude-opus-5-5`, effort `xhigh`, in a bounded shared-checkout task. Tested backend source and executable are saved under `target/evidence/pre-opus-20261118/`. The worker owns backend changes; the coordinator retains dashboard/journal ownership. This is an implementation retry, not the final scoring council.

## Round 16 — pending scope and selection contrast

While the bounded Opus storage attempt runs, a held-response browser check reproduces a dashboard defect at both 1280 and 390 px: fading the entire totals grid makes its text fail contrast while a new global filter loads. The grid now keeps its normal contrast and shows “Totals for the previous selection” only when it actually displays ready values from the preceding selection or committed date window. Picked model rows use their own loading state; an unrelated unpicked overview request cannot label their skeletons or fresh totals as old values.

The picked-row regression finds a second whole-row opacity defect. Model names measure 3.94:1 and coverage text 2.02:1 against black, below the required 4.5:1. Selection/focus no longer fades text. Selected names retain their underline and weight, buttons retain `aria-pressed`, and chart-line emphasis remains. Logs `runtrace-pending-scope-red-both.log` and `runtrace-pending-scope-final.log` preserve the two reproduced failures.

The production frontend builds successfully. All 264 units pass (`runtrace-pending-scope-units.log`). Four focused browser checks pass in 54.2 s (`runtrace-pending-scope-final-green.log`), including full-page axe and document-width checks at both widths. A strengthened rerun passes both picked cases in 48.8 s (`runtrace-pending-scope-numeric.log`): the selected request returns 200 and its displayed Prompts count agrees with that response while the global request remains held. Astra's bounded source review accepts the caption/contrast fixes and prompted that numeric assertion; it does not claim rendered verification.

The coordinator inspected all four neutral captures in `target/evidence/pending-scope-final-green/`; labels, coverage text and totals remain readable, with the existing monochrome design. Tests use a private Vite output directory and the saved pre-Opus service executable. The embedded dashboard and live installation are unchanged. This is focused frontend evidence, not a new whole-branch integration pass.

Scores remain reliability 6, quota 8, storage 6, insight 8, direct access 8 and engineering 6: weighted 6.90. Storage and reliability remain the next targets. Full integration waits for the bounded backend attempt; no additional coordinator memory-tuning loop is started.

## Round 17 — bounded Opus result and retained candidate

The Opus 5.5 attempt is finished without qualification. In paired from-scratch attempts, the Windows segment-heap process peaks at 328,339,456 working-set bytes / 320,708,608 private bytes in 2,958.406 s, but completes only 27/36 projects. The NT-heap control peaks at 406,147,072 / 395,628,544 in 3,552.078 s and completes 29/36. Both report `partial_sync: true` and native `database_memory_limit` failures. They ran concurrently and complete different amounts of work; no speed comparison or completed-import memory pass follows. Neither reaches the 500-request stage.

Both full diagnostics use the saved executable with a sidecar selecting the process heap, verified from the native heap signature. The final embedded candidate is separately checked without a sidecar on the neutral wide fixture. Its pre-integration SHA-256 is `acf0ca619d51b32b62dd326c4416d8a354440fac8568f28f426316874d3b764d`. The 328 MB partial result is not silently relabelled as a complete import or a full run of that final executable. Private evidence is preserved in `target/opus-storage-20261118/REPORT.md`, `heap-ab-full-{segment,nt}.log`, `run-summaries.json` and `final-binary-heap-check.log`.

A separate disposable probe records 303,048 record keys, 89,391,104 bytes tagged `ART_INDEX`, and a native allocation failure at roughly the 112 MB database budget. This supports index pressure as the next obstacle. It does not establish a general allocator mechanism or a working-set cap. No schema, identity-key or importer redesign is attempted after the user's stop-tuning instruction.

Astra's bounded independent source review recommends retaining the segment-heap setting: equal-progress samples consistently use less working set, including about 320 versus 383 MB at 2,400 segments. Its two findings are corrected: the PE32+ test is restricted to 64-bit Windows MSVC, and comments describe the measurement without asserting fragmentation or predictable release of freed pages. The implementation changes only binary manifest embedding and its regression; existing import semantics/defaults remain. The saved pre-Opus backend/executable remain available, alongside a separate preserved copy of the reviewed candidate.

The worker's candidate passes 112 Rust tests, formatter and zero-warning clippy. After the small review corrections, the coordinator's combined candidate also passes all 112, formatter, zero-warning clippy and a release build (35.37 s). Its SHA-256 is `27c8eb9730b74de06a2d4ca2b37d1cc222c9492227ef598c6c329ed2d447254a`; the executable and a source-hash manifest are preserved in `target/evidence/retained-candidate-20261118/`. Logs: `runtrace-retained-{fmt,all-tests,clippy,release-build}.log`. The benchmark validator's six tests pass, including rejection of partial projects; a sensitive SQL-pattern scan returns no matches. Supervisor qualification passes crash recovery in 3.843 s, same database, intentional stop/backoff/restart and 16 Host checks (`runtrace-retained-supervisor.log`). Complete browser/update/stress qualification is still underway. Scores remain 6/8/6/8/8/6, weighted 6.90. Storage remains unqualified. Per the user's instruction, memory tuning stops; next are retained-candidate integration and the remaining operational checks. The live installation, relay and startup registration are unchanged.

The complete retained-build dashboard run subsequently passes all 264 units and **179 browser tests in 2.8 minutes**, including the four pending-scope regressions, thirteen-page global-filter checks at both widths, axe/overflow, numeric API comparisons and frame-rate checks. Logs: `runtrace-retained-ui-tests.log`, `runtrace-retained-e2e.log`; captures: `target/evidence/retained-final-browser-20261118/`. This closes the combined-suite gap. Engineering rises from 6 to 8; the unpatched development dependency advisory remains open and no clean full audit or hosted CI is claimed. Scores are now reliability 6, quota 8, storage 6, insight 8, direct access 8, engineering 8: weighted **7.20**. The seeded large scratch collector has resumed its prior committed progress at the normal serving budget; updater and mixed-read results are still pending. The first-import gate remains failed, and no council is requested.

The retained-build standalone updater also passes (`runtrace-retained-update.log`): 21.953 s update cycle to a temporary-only version, checksum rejection before stop/replacement, restart after backup failure, same database, four exact API digests, two independently copied cold segments usable without their originals, identical candidate bytes and installed start/stop scripts. No side-by-side DuckDB DLL is required. The temporary fixture builder proves the checkout version/lockfile/executable were preserved. This is scratch lifecycle evidence; the live installation is unchanged. Mixed-read qualification remains running.

## Round 18 — visual review and missing turn statuses

The coordinator visually inspects all thirteen retained-build pages at 1280 and 390 px, plus both populated timed-chain captures: 28 neutral images in `target/evidence/retained-final-browser-20261118/`. No new layout defect is found. The captures show the global machine/status selection, installation-wide quota/storage/settings explanations, efficiency denominators and the partial timed chain's lower-bound label. The complete browser suite supplies axe, overflow and interaction checks. A SHA-256 inventory records these inspected captures in `visual-review-manifest.json`; screenshots alone do not establish screen-reader behavior.

A nearby source check identifies a status-coverage defect: Harnesses hides all-zero failure/stopped columns and says no turn failed even when status is missing. Six new browser cases cover 0/2, 1/2 and 2/2 reported statuses at both widths. Against the retained executable, the four missing/partial cases fail and the two fully reported cases pass (`runtrace-harness-status-red.log`). The correction keeps status columns visible when coverage is incomplete, says how many turns reported a status and states that those rates use only reported statuses. The all-zero shorthand remains available for fully reported history. Complete integrated verification of this frontend correction is underway; the prior tested executable remains preserved. No first-import tuning or live change occurs. Scores stay 6/8/6/8/8/8, weighted 7.20; the large-history serving/stress and real operational gates remain next.

The status correction passes all 264 units and the complete **185-test browser suite in 2.8 minutes** (`runtrace-harness-status-{units,e2e}.log`), including axe/overflow in all six new cases. All six captures are inspected. They expose a separate single-harness fallback defect: when only Codex has turns, both Balance sides say Codex. The fallback now always chooses a distinct comparison harness, and those cases additionally assert Codex/Claude Code labels. This last correction is in a new integrated build/suite run; the preceding 185-test pass is not claimed as evidence for that later line change.

The final combined Harnesses corrections also pass **264 units and all 185 browser tests in 2.8 minutes** (`runtrace-harness-final-{units,e2e}.log`). Release build: 34.26 s. Final executable SHA-256: `a2ed3e44de1da3bd917555acc3f283b4e3ff1771724bae58a26f9ebbb28b115f`, preserved in `target/evidence/harness-final-candidate-20261118/`. Its native/config/migration/script hashes match the 112-test checkpoint; the two production changes since that checkpoint are frontend-only. The coordinator inspects the final partial/unknown captures at 1280/390; their inventory is in `target/evidence/harness-final-integrated/visual-review-manifest.json`.

Actual direct Tailscale HTTPS is requalified on a separate temporary port using that final executable (`runtrace-harness-final-direct.log`): four default remote-authority rejections, four allowed routes returning 200, four unrelated-Host rejections and the scratch PID confirmed through the public health route. No relay is used for those requests. Cleanup removes its temporary handler, verifies the pre-existing Serve configuration is unchanged and checks the existing link still returns 200. The live mapping still uses its original relay; this scratch result is not a live cutover or logon proof.

Scores remain 6/8/6/8/8/8, weighted 7.20. The large-history stress process continues with the preceding retained executable (`27c8eb97…`), whose backend is identical; it does not establish final frontend provenance. Its initial collection is not yet synced, so no 500-request pass is claimed. Storage/reliability remain the next targets, with first-import memory tuning stopped by the user's instruction.

The resumed collector reaches 36/36 completed source project scopes in the persisted data-quality progress before the driver reaches its 30-minute initial-readiness deadline. The overall health collector has not yet reported synced, so no mixed requests run. The driver stops its own service in cleanup; the coordinator confirms that PID is absent and only the original live service remains. This is a harness timeout, not evidence of a 503 or completed cold maintenance. A further serving check resumes the same committed database with the final executable and seed 2026111821. No source/database copy is reset, the initial-readiness and successful-collector gates are unchanged, and first-import memory tuning does not resume. Private aggregate progress observations preserve the 35/36 and 36/36 states; logs are `runtrace-retained-large-stress.log` and `runtrace-harness-final-large-stress.log`.

Read-only operational preflight confirms the installed executable is unchanged, Tailscale is automatic/running and Runtrace has no logon registration. An older analytical database/WAL backup pair is present (3,567,421,528 bytes); that pair's restore has not been verified here. A scratch-only legacy qualification helper is prepared and syntax-checked, with independent paths, source-copy hashes, logical API parity, snapshot/restore and all-column verification. It is not executed while the large collector is active, and earns no recovery credit. No live or registry mutation occurs.

## Round 19 — full-source serving and randomized mixed reads

The final executable (`a2ed3e44de1da3bd917555acc3f283b4e3ff1771724bae58a26f9ebbb28b115f`) passes **500/500 mixed requests with HTTP 200 and zero 503s**, four workers, seed 2026111821, on the resumed frozen-history database. The successful collector reports all **36 projects / 4,583 threads**, no partial sync and no project errors. Its successful-sync timestamp advances from 16:10:49.958 to 16:14:03.695 UTC during the workload. Twelve route types include 500-tool pages, offset 1,500 and full content. The run takes 199.797 s, median 1,110 ms and p95 4,640 ms including HTTP and JSON handling. These are serving measurements at a 2,048 MB database budget, not a first-import memory pass.

Automatic 30-day maintenance reports **163,032 moved rows / 65 segments**, with copy and native restore verification. A later explicit compaction also verifies 62,977 moved rows / 17 segments at its later cutoff. The complete post-move snapshot writes **380,746 records across eight tables**, 800,663,523 Parquet bytes. Its restore and the independent all-column comparison are still running; no complete snapshot-restore pass is claimed yet. A separate older analytical-backup copy also begins migration/API-parity/restore qualification, with input-copy hashes matching. The original backup and live installation remain unchanged.

Private evidence: `runtrace-harness-final-large-stress.log`, the scratch `result.json`, aggregate `target/evidence/harness-final-large-stress-summary.json`, and `runtrace-harness-final-large-restore.log`. A working-set sample during serving is 2,688,536,576 bytes; it is not the lifetime peak. The native budget does not cap total process memory, and no serving-memory limit was specified by this gate. The failed first offline import still receives no memory credit. Performance figures and these scope distinctions are recorded in performance-and-compression.md.

Storage rises from 6 to 7 for the real full-source serving/maintenance/stress evidence. Complete snapshot restore and the historical hot/cold API comparison remain pending; the first-import ceiling remains failed. Reliability 6, quota 8, storage 7, insight 8, direct access 8, engineering 8: weighted **7.40**. Reliability now loses the most weighted points. No council, deployment, startup registration, commit or push occurs.

## Remaining qualification

### Logon observer preparation

A private one-shot observer is prepared but not armed. The initial logon-SID-to-WMI lookup fails on this host; no startup credit follows. The replacement reads the token's [`AuthenticationId`](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_statistics) and the native [`LogonTime`](https://learn.microsoft.com/en-us/windows/win32/api/ntsecapi/ns-ntsecapi-security_logon_session_data), retaining only a hash of the identifier. A changed boot or authentication ID identifies a new logon. The positive predicate also requires direct local/public 200 responses, both health readiness flags, matching PIDs, the qualified executable path/hash, process creation after logon and observation within 120 seconds.

Astra's source review catches stale-result acceptance, redirect following, a pre-logon tolerance and a shared-state race. These are corrected before registration: immutable per-attempt directories/results, strict time comparisons, redirects disabled and per-attempt [`RunOnce`](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys) entries. Windows owns one-shot removal. The final bounded recheck finds the cross-attempt race resolved.

Native negative checks pass: pending cannot qualify; an earlier success is rejected; later preparation preserves earlier input/script; an earlier probe cannot overwrite the later result; an existing attempt cannot be reused as the parent; the same real logon is rejected. All RunOnce entries remain unchanged. Proof: `runtrace-logon-probe-guards.json`; private helper SHA-256 `393ec652695eb54688d3dd645a3100ba098fde06b55ac2a6a3946883b3a7e057`; startup command 204 characters. No real positive cycle, installation change, registration or logoff has occurred.

No full-history import has passed the 400 MB gate. Both the neutral-fixture checks and the completed real-history 500-request pass are recorded above. Real logon/reboot recovery and an actual sleep/resume cycle remain unqualified. Final whole-branch checks and the council are conditional on completing the scorecard first.

The preceding development-dependency advisory is superseded by the final full audit below. Previously there were five high development entries and zero production entries. Astra's bounded reachability review finds no supported app/build/test path accepting an external glob pattern; Vite deny patterns and Vitest includes are trusted configuration, and request paths are match strings. No upstream patch or clean full audit is claimed.

The evidence journal was reconstructed from the preserved preceding report, review captures and command logs after a Windows encoding failure. Application code and measurement files were unaffected. Future journal writes use explicit UTF-8.

## Round 20 — complete restores and final integration

Independent private verification matches all stored columns across the exact eight schema-v4 tables after restoring the full post-move snapshot: 380,746 records, all 40 record columns, and zero row-hash multiplicity differences in every table. A copied historical analytical backup separately restores 441,832 records and matches every stored column in all eight tables. Its migration changes record-column order, and a historical cold expression serialized `preview_doc` as JSON rather than its native VARCHAR. The checker aligns complete column-name sets, accepts that narrow historical alias, preserves null versus empty text and compares duplicate counts. Negative controls detect modified preview text, a missing column and unrelated type changes. The observed unordered scan sequences differ; no claim about physical row order or storage-byte identity follows.

The historical backup's twelve API routes have identical canonical JSON digests before and after cold eviction, with content retention applied before the baseline and the clock held fixed. Its old driver exits at an overly strict scan-sequence assertion after the all-column check succeeds. The saved all-column result, rather than that exit status, proves stored-value equality. No paired final original-file checksum claim is made for the aborted driver.

The production correction casts only the cold preview expression back to VARCHAR. A native-schema regression fails before the fix and passes afterward; a second regression checks exact API equality across eviction for already-expired previews. Current executable SHA-256: `ba44da937644c9a678a0dcff0c73a591337d15abf2d63804e1a3a84ec5e43bc2`. It passes 114 Rust tests, formatter, zero-warning clippy, a release build (63 s), 264 dashboard units and all 185 browser tests (3.3 min). Current full `npm audit --include=dev --audit-level=low` reports zero vulnerabilities; the installed dependency tree uses picomatch 4.0.7. No dependency change is attributed to this round. The frontend is unchanged from the inspected preceding captures; this suite rechecks its embedded-asset identity, axe and overflow.

The final executable also passes seeded mixed reads during advancing full-history collection: seed 2026111822, four workers, twelve route types, 500/500 HTTP 200, zero 503, 196.797 s, median 1,125 ms and p95 4,704 ms including HTTP/JSON handling. Collection advances from 17:36:55.242 to 17:40:08.629 UTC, with 36/36 projects, 4,583 threads, no partial sync and no project errors. This run copies the preceding committed scratch database and uses the ordinary 2,048 MB serving budget. It does not qualify a first import below 400 MB. Concurrent browser activity means these timings are not a controlled speed comparison. Crash recovery passes in 4.328 s, including idempotent start, deliberate stop/backoff/restart and sixteen Host checks.

Astra's bounded source review accepts the full stored-value claim, the narrow compatibility rule and the production cast. It corrects the scan-order wording and requires explicitly checking `all_stored_columns_equal`, since process exit alone does not assert equality. This is a source review, not the final council.

Evidence is preserved in the private D: qualification directory: `preview-candidate/` (binary, native logs and source hashes), `preview-final-stress-summary.json`, `restore-summaries.json`, `preview-browser/`, and `runtrace-preview-final-{units,e2e,large-stress,supervisor,audit}.log`. Earlier raw restore results remain in their preserved private scratch locations. No real project/thread/client names or response contents are copied into this report.

Scores: reliability 6, quota 8, storage 8, insight 8, direct access 8, engineering 9; weighted **7.75/10**. The next target is reliability. First-import memory tuning remains stopped after the failed bounded retry, per the user. Real logon/reboot recovery, an actual sleep/resume cycle and live direct routing remain unqualified; physical cold-file reclamation and other documented product gaps remain. No 9 or final council is claimed. The live installation is unchanged. At the user's direction, source migration to a separate `source` directory under the installation root follows this completed test boundary; installed files and live data are excluded.


## Round 21 — source migration and executable selection

At the user's request, development moves to `D:/Code/Runtrace/source`, separate from the installed `bin/config/data/backups` directories. All 76,169 files / 138,292,602,510 logical bytes are copied and SHA-256 verified, including every target artifact, diagnostic and evidence file. Independent source/WIP and diagnostic-source archives pass per-entry checks. Git history, all named refs, branch, HEAD, local configuration and dirty/untracked state match; full fsck passes. One pack file changes its modification timestamp during the copy, but its size and SHA-256 remain identical. The safety gate stops first, the byte identity is checked explicitly, then migration continues. No content difference is waived.

T3's supported project update changes the workspace and icon reference. The current thread and `git worktree list` report the new source root on the same branch/HEAD. A final full checksum pass matches every old source file again before retirement. Only the verified old source contents are removed. The old protected live-data junction remains untouched; it is never traversed, copied or recursively deleted. The installed service, configuration, backups and relay are preserved. Private migration manifests and receipts live outside the public repository.

Mandatory D: scratch settings expose stale hardcoded target paths. The source installer, installer verifier, browser fixture and temporary update builder now honor `CARGO_TARGET_DIR`. Isolated temporary builds set their own target instead of inheriting and overwriting a shared executable. A neutral path-selection check puts an invalid stale executable in the default checkout target: the archived installer fails, while the corrected installer selects the configured binary, starts a real isolated service, confirms readiness/disabled collection and stops it. Build commands are mocked; no migration build is claimed. Separate mocked checks exercise shared and isolated update-builder routing and preserve the original binary. TypeScript and PowerShell parsing pass. The browser fixture also starts from the selected D: target with the old C: source absent.

Scores remain 6/8/8/8/8/9, weighted **7.75**. No additional score credit is awarded for relocation. Reliability remains next; first-import tuning remains stopped and real logon/sleep/live-direct gates remain open. No commit, push, release or final council occurs.

The complete browser suite also passes from the migrated source using the configured D: target: **185/185 in 2.6 minutes**, with the old C: source absent. Post-migration checks retain the original live PID and executable/configuration hashes; both local and public health are ready, public HTTP is 200, and no old-source build/test process is observed. No Rust or frontend production build is performed for relocation. Evidence: `migrated-e2e-full.log`, `live-preservation.json` and the private migration receipts.


## Round 22 — installed supervision and direct HTTPS

The qualified local executable `ba44da937644c9a678a0dcff0c73a591337d15abf2d63804e1a3a84ec5e43bc2` is now installed. Before any replacement, all 41 recorded backend/config/migration files match its preserved source hashes. A neutral old-to-new rehearsal verifies exact executable/configuration rollback after an injected failure at the replacement boundary, independent old-backup startup, same storage identity and Host admission. A second rehearsal verifies the fresh freeze-without-restart boundary and recovery after replacement. A preflight bookkeeping threshold first rejects the number of files; it is corrected to compare the exact complete file set and every hash. No live change occurs during those rehearsals or that correction.

The live `stop.ps1` and `start.ps1` wrappers take and recover a byte-verified frozen database/WAL copy with the existing executable. Its separate candidate copy has zero changed original rows and identical logical statistics. Twelve API routes return 200, and a warm candidate start takes 3.891 s. A separate copy starts with the old executable and retains the same statistics. The immutable rollback generation is reverified after testing. These are operational checks on existing history, not a first-import memory pass.

The final transition takes another fresh verified frozen pair before replacement. All four local routes pass by 16.781 s after the transition begins; all four direct public HTTPS routes pass by 17.0 s. Tailscale changes only this installation's existing handler, forwarding directly to loopback port 4310. The complete before/after Serve state matches apart from that one proxy target. The relay process is stopped, port 4311 is no longer listening, and direct public health still returns 200 with the installed process identity. The listener remains 127.0.0.1. Eight fixed unrelated-Host checks and 100 randomized unrelated authorities return 403; prior scratch checks separately prove the empty default allow-list rejects remote authorities.

The installed `start` launches its supervisor. `autostart on` writes the exact installed executable/configuration command in the user's Run key; no StartupApproved record disables it. The one-shot observer is armed with a fresh attempt and the installed hash. A real new sign-in is **not qualified**. The user explicitly defers signing out/in, so the Windows session is left running. No sleep/resume is forced. Removing the relay dependency supersedes starting that auxiliary process at logon; Tailscale itself is automatic, and its direct handler persists. Registration and healthy HTTP are not substituted for the required real logon test.

The installed collector subsequently reports all **37 discovered project scopes synced**, no partial sync and no project errors. Automatic cold maintenance reports **499,450 moved rows**, with copy and native-restore checks true. HTTP readiness precedes completion of the initial collection; it does not imply that all observation fields are available.

The latest pre-transition generation is independently restored with the original executable and unchanged logical statistics. Its six frozen files are also copied and individually SHA-256 verified into a durable `qualification-before-...` generation under the installed backups directory. The original relay file is preserved for recovery. All previous backups remain untouched. A hidden relay restart is separately rehearsed against an old scratch executable and isolated ports/database. The guarded post-cutover emergency rollback helper is syntax-checked; its replacement/restore/relay components are exercised separately, and a whole rollback of the healthy live installation is not claimed.

Fresh current-build quota verification confirms two Windows display acknowledgements at 20% and 5%, config-off and separate-process restart deduplication. It uses neutral quota data and the current static executable; a matching DuckDB DLL serves only as the Python fixture writer. The installed service needs no such DLL. Live quota has six harnesses: five with numeric readings and one with an unavailable state. All 44 partial windows have reasons; 487 gaps have valid bounds. No recorded Windows sleep cause appears in this live sample, so actual sleep/resume remains unqualified. The current real-window holdouts have 4 and 15.924 percentage-point errors. Those results preserve the projection label and do not establish general forecast accuracy.

Private proof is in `D:/Scratch/Runtrace/reliability-20261118`: `round22-evidence.json`, transition/freeze/relay rehearsals, fresh-copy and latest-rollback reports, live cutover and Host reports, durable-backup receipt, live quota inventory, native warning output, holdout output and the pending observer attempt. It contains no public-repository screenshots or fixtures with real project/client/thread names. The installed backup generation is retained separately from the source checkout.

Reliability rises from 6 to **8** for installed supervision, tested recovery and registered startup, with the real-session gate still missing. Direct access rises from 8 to **9**: the live link works without its relay, defaults remain localhost-only, and unrelated Hosts are rejected. Quota 8, storage 8, insight 8 and engineering 9 remain. Weighted score: **8.25/10**. No 9 or final council is claimed. Remaining priority is quota/dashboard/storage qualification while the user defers the sign-in cycle. The first-import 400 MB gate remains failed and further memory tuning stays stopped, per the user's instruction. No commit, push, tag or GitHub release occurs; this is a local qualified build installation.

## Round 23 — failed-publication cleanup and truthful dashboard labels

With the user deferring the real sign-in cycle, this round addresses storage and dashboard evidence gaps without restarting memory experiments. The installed qualified executable remains unchanged.

The cold-publication regression first fails after `after_copy`: the archive contains an additional unregistered `.parquet.tmp` file. After the fix, all four injected failure boundaries (`after_copy`, `after_delete`, `after_rename`, `before_commit`) restore the exact prior archive filename/checksum map and logical query result. Committed segments and an unrelated sentinel survive. A separate regression deliberately presents a committed path to cleanup and verifies that all candidate files are retained. Cleanup acts only on this attempt's unique paths after a confirmed rollback and a manifest check. A failed rollback or uncertain ownership retains files with an error context. This fixes caught publication failures; it does not claim cleanup after process termination, obsolete immutable-file reclamation or forensic erasure.

Astra's read-only Models review finds no machine/status leak but identifies two misleading labels. The headline now describes requested models, and the ledger names its configured-thread count explicitly. A new native neutral fixture executes the reviewer's predicted distinction: two local failed runs request model A, while their two threads were configured for A and B; a completed-only thread and reused remote IDs do not contribute. The result is two runs, two turns, one configured thread in model A's ledger row, and two filtered threads configured A/B. Browser tests verify the requested/configured distinction at 1280 and 390 px. The reviewer did not execute the fixture; this round's native test does.

Manual page inspection also reveals that Projects used the same dot, labelled “No tokens,” for missing daily readings. The new regression fails at both widths with that dot. The page now distinguishes unreported totals, a measured zero, and known aggregate totals without loaded daily readings. Its hint explains that daily traces can be incomplete. Four focused browser regressions pass with zero axe violations and no document overflow. All 264 frontend unit tests pass and the production frontend builds.

The root agent inspects all thirteen page captures at both widths, plus the populated partial-timing tree at both widths. Changed Models and Projects captures are inspected separately. They use neutral synthetic data. No additional layout defect is observed. The installed service is separately still ready with the same process identity, 37 synced project scopes, no partial sync or project errors, and public health HTTP 200.

The first full native command fails at link time, before tests: a copied build-script cache still names the retired workspace's Windows manifest. The six files in that exact package build-output/fingerprint pair are privately archived and SHA-256 verified before invalidation. No dependency cache, native library, source or installed file is removed. Re-running generates the manifest path in the D: source checkout. All 117 native tests then pass, including the embedded-manifest test, and the debug program builds. Formatter and clippy pass with warnings treated as errors. Opus 5.5 independently reviews the cause and bounded cache invalidation; it recommends no production source change. Its review notes other historical absolute paths in the copied cache, so a release qualification must use a fresh target. It does not claim the whole workspace run had completed at review time; the root's later command establishes that result.

The first integrated browser run reports 184 passes, four failures and one test not run. Three failures are selectors that assumed only one explanatory paragraph on Models; the fourth expects the old run-share wording. Assertions are updated to retain the missing-field check and require the exact requested-model headline. The complete rerun passes **189/189 in 4.2 minutes**, including the frame-rate check. All thirteen pages have axe and overflow coverage at 1280/390. The early four focused UI checks used the prior debug backend with the current on-disk frontend; the integrated runs use the newly rebuilt debug program. None is presented as a release-profile qualification.

The same debug executable (`4c723c013cbda42ba2e38a5c01012c38490122d4b73e7471e46b8e5a147bc280`) passes a new 500-request mixed workload, seed **2026111823**, with four workers and twelve route types: **500 HTTP 200, zero 503**, **230.594 s**, median **1,250 ms**, p95 **5,406 ms**. Collection advances and stays synced across all **36/36** scratch project scopes without project errors. Automatic cold maintenance moves 38 rows in two segments, with copy/restore checks true. This uses copied completed scratch progress and a normal 2,048 MB serving budget; it is not a first offline import or a process-memory qualification. It overlaps the browser run, uses a debug executable, and does not establish a release speed improvement. An initial preparation check rejects another scratch source because its WAL exists; no WAL is ignored or discarded. The successful run uses the prior committed scratch checkpoint and verifies the database/source copies before startup.

The visual receipt compares 26 integrated page captures with the manually inspected migration captures: 15 are byte-identical. The root inspects changed Models/Projects captures and the remaining changed pages, plus both partial-timing trees. Private logs, screenshots, the failed-command outputs, cache recovery receipt and the source/executable hash receipt (`round23-evidence.json`) are retained under `D:/Scratch/Runtrace/lifecycle-20261118`. No real-history screenshots enter the repository. The source and T3's saved project setting both point to `D:/Code/Runtrace/source`. The installed executable, database and startup observer are unchanged; no old-source build/test process is observed. Retained C: scratch inputs and immutable cold files still have read dependencies and are not cleanup targets.

Scores remain **8 / 8 / 8 / 8 / 9 / 9**, weighted **8.25/10**. The fixes and debug integration checks close verified defects; a fresh bundled release-profile qualification is the next target before any installation change or further score credit. Real logon, actual sleep/resume, the failed first-import memory ceiling, and physical cold-file lifecycle limitations remain open. No 9, final council, commit, push or release is claimed.

## Round 24 — fresh release-profile qualification and all four run statuses

The default bundled executable is built in an initially empty D: target, without copying the migrated Cargo cache. The first build completes in 10 minutes 43 seconds. The scratch installer rebuilds the frontend, starts its own disabled-collector service on an unused port and stops it through its installed wrapper. The optimized embedded-manifest test passes. The frozen qualification candidate is `4dafe7774bdb88ceb344780ddbb72236a24151a22751957aac57c3dde39f3bd5`. It is an uncommitted 0.2.4 WIP build identified by its hash, not the published v0.2.4 artifact. No version is changed in the real checkout and no release, commit, tag or push is created.

All **117 native tests pass in release mode**, all **264 frontend tests pass** after dependency refresh, and all **189 browser tests pass in 3.0 minutes** against the frozen executable and its embedded dashboard. Formatter and clippy pass with warnings treated as errors. The global-scope acceptance fixture now explicitly covers completed, failed, running and cancelled containing runs, with reused source IDs on four machines. Each status is tested with and without an instance filter across seven list endpoints. Completed tools and turns retain their containing run's status scope. Extending the fixture first exposes an obsolete expectation of one unfiltered Codex machine; its expected set is corrected to exactly the three matching machines, still excluding the mismatched one. The full suite then passes. This changes validation code only.

All thirteen pages have 1280/390 axe, overflow, navigation-hit-target and URL-scope coverage. Of 26 current page captures, 21 are byte-identical to the previously inspected captures. The root agent inspects the remaining five and both populated partial-timing trees. No additional layout defect is observed. The observed timed chain remains labelled as such, including missing timing and unrecorded parent waits. Tool-call/turn and retry/thread ratios retain their measured coverage. Requested-model usage and configured-thread starts are distinct, and missing project token readings are not zeros.

A new mixed workload, seed **2026111824**, returns **500/500 HTTP 200, zero 503** over twelve route types and four workers while collection advances and stays synced across **36/36** scratch project scopes. It takes **181.453 s**, with median **1,015 ms** and p95 **4,094 ms**. Automatic maintenance moves 38 rows into two segments with copy/restore checks true. This uses copied completed scratch progress and the normal 2,048 MB serving budget. It is not a first-import or process-memory qualification. Browser/native checks overlap parts of this run; no paired speed improvement is claimed. Crash qualification recovers in **4.39 s**, retains the database, and verifies idempotent start, intentional stop, restart after stop and stop during crash backoff, plus sixteen Host-admission checks.

### Updater evidence and a retired historical method

An initial upgrade test downloads and checksum-verifies published 0.2.3. Its strict API comparison fails on quota windows: three other responses match, while quota windows add only `coverage_reasons` and `gaps`. A read-only Opus 5.5 review independently compares the saved responses and confirms all original fields, types, row order and envelope metadata are unchanged. It requests type-sensitive canonical JSON comparison and exact reason/gap assertions; those corrections pass. Its reviewed capture has 92 gaps; a later fixture run validates 86. Those counts belong to separate captures, not a claimed fixed sample count.

The review also identifies TIMESTAMPTZ casts inside that historical implementation. Running it was incompatible with the task's no-ICU rule and should have been checked beforehand. That driver is now guarded against execution, the historical artifact is marked not to run, and its source/results remain privately preserved. **Historical-binary results are excluded from compliant qualification.** The current source is not changed to accommodate that older code.

The replacement updater check uses a **synthetic version fixture built from the current code**. Its copied inputs differ only in private Cargo version metadata, labelled 0.2.3 to trigger an actual executable replacement with the frozen 0.2.4 candidate. It is not presented as a published historical binary or historical-schema proof. An initial fixture build fails because eight SQL migration inputs were omitted from the copy; they are added and individually hash-verified against both the current source and the previously qualified source. The complete comparison covers 155 input files, with only `Cargo.toml` and `Cargo.lock` differing between the real source and version fixture. Runtime and migration source scans have no forbidden SQL matches across 34 files.

The compliant updater cycle passes in **21.843 s**, including checksum rejection before stop/replacement, restarting the previous service after an injected backup failure, identical database identity, four exact API digests, exact candidate bytes, and start/stop after replacement. Its two registered cold segments survive backup and restore while the original archive is hidden. The candidate starts without a DuckDB sidecar, and the loaded-module check finds none. This directly exercises the current updater code. Existing complete-history stored-value restores remain separate evidence; this smaller fixture does not replace them.

The version-fixture build also exposes a mutable-cache hazard: Cargo leaves the shared target's named executable at the fixture version after a nominally fresh main build. The frozen qualification executable is unaffected. Workspace-only build/fingerprint cache units are archived and hash-verified before invalidation and a main-version rebuild; native dependency caches and all qualification evidence are preserved. Future version fixtures must use a separate target. Initial input and failure receipts are retained rather than overwritten.

Private proof is under `D:/Scratch/Runtrace/release-round24-20261118`, including `round24-evidence.json`, source/migration receipts, build and test logs, screenshots, stress results, current-code version-fixture receipts, updater output and cache-recovery records. The installed executable and pending sign-in observer remain unchanged. Production still uses the qualified Round 22 build.

Dashboard insight rises from **8 to 9** for the completed requested criteria on the qualified candidate: observed timed chain, global URL scope, explicitly covered efficiency ratios, and inspected/axe-clean desktop and phone layouts. Reliability **8**, quota **8**, storage **8**, direct access **9** and engineering **9** remain. Weighted score: **8.40/10**. This is not an overall 9. Real sign-in, actual sleep/resume, the failed first-import memory ceiling and remaining physical cold-file lifecycle limitations stay open. Further import-memory tuning remains stopped. The next target is reviewing and rehearsing a safe local installation transition before changing the live build; no final council is requested.

The main mutable cache is restored to version 0.2.4 after archiving and hash-verifying 66 files in 17 workspace-only cache units. Its rebuilt hash is `4f1e570d548fc9913f2d3556f3d698bc0ad9e377088132b0c7bb5cc10022f06f`; that cache output is **not** the frozen qualification candidate. Only the frozen `4dafe777...39f3bd5` executable carries this round's runtime qualification. Final live verification retains PID 41164, 37 synced scopes, zero project errors, public HTTP 200 and the unchanged installed `ba44da...43bc2` hash.

## Round 25 — real COMMIT-failure cleanup and replacement rehearsal

Qualification ran on 18 November; this report was finalized after midnight on 19 November. The next tied priority was storage publication safety before any candidate installation. Separate Astra 6.2 reviews pinned the captured source: Standards found no issue; Spec found one medium defect. A real DuckDB COMMIT failure can roll back internally, making the subsequent explicit ROLLBACK fail. The old handler returned before removing the attempt's renamed, unregistered Parquet file. This was reproduced by creating an empty directory at the scratch WAL path immediately before the real COMMIT. It did not use the live database, exhaust disk space or alter permissions.

The corrected handler attempts rollback and then establishes an independent read transaction for manifest inspection, even when the first rollback failed. It checks all existing attempt-owned candidates and closes that transaction before deleting anything. An active prior transaction, registered candidate or inspection failure preserves the files. A post-commit error must retain the newly registered segment. The two focused tests now cover six failure boundaries, exact archive filename/checksum preservation, query equality, unrelated-file preservation and refusal to nest cleanup into an active transaction. The actual WAL-failure reproduction fails before the correction and passes afterward.

Both independent rechecks are clear: **Standards 0 findings; Spec's medium finding closed, no new findings**. They reviewed captured source and supplied red/green logs; neither reviewer independently ran the tests. Reviewed `cold.rs` SHA-256 is `588cfefacdad5870bf055d52b06d32b49bca1262a4ba603592ea7f3a52526d22`. These are bounded implementation reviews, not the conditional score council. Process-termination orphan recovery and physical immutable-file reclamation remain outside this fix.

The frozen bundled candidate is `161fc0f85cad6d4fe7b8b87fdac876f8897025dfe4046aeb4b5000f4586b84ea`, an uncommitted 0.2.4 WIP executable. **117 optimized native tests, 264 frontend tests and 189 browser tests pass**. Formatter and clippy with warnings denied pass. The browser suite completes in 3.0 minutes and includes thirteen pages at desktop/phone widths, axe and overflow checks. The frontend is unchanged from the preceding manual visual inspection; no new manual all-page inspection is claimed in this round.

A new randomized serving pass uses seed **2026111825**, four workers and twelve route types: **500/500 HTTP 200, zero 503**, 198.875 seconds, median 1,125 ms, p95 4,281 ms. Collection advances with 36/36 scratch scopes synced and no partial sync or project errors. Automatic maintenance moves 99 rows in three segments with copy and restore checks true. This copies completed scratch history and uses the normal 2,048 MB serving budget. It does not establish a first-import memory ceiling or a paired speed improvement.

The corrected candidate also passes the current-code synthetic-version updater fixture: checksum rejection before replacement, backup-failure recovery, four exact API digests, detached cold-backup verification, unchanged database identity, standalone execution and installed start/stop wrappers. The fixture is not a published historical implementation; the prohibited older binary is not run. Supervised crash recovery takes 4.328 seconds, with intentional stop, restart/backoff and sixteen Host-admission checks passing.

A separate neutral scratch installation rehearses the replacement boundary with the installed previous executable. After an injected interruption before candidate startup, every restored file matches the frozen backup's SHA-256, and the previous executable restarts with the same database identity and four exact API digests. A second replacement starts the corrected candidate successfully, preserving those digests and identity. The scratch service is stopped afterward. This is evidence for the tested replacement/rollback path, not a claim that the live installation has been updated.

Private evidence is under `D:/Scratch/Runtrace/transition-round25-20261118`: `tmp/commit-wal-red.log`, `tmp/commit-outcome-tests.log`, `review-r2/`, `candidate.json`, `tmp/native-release-suite.log`, `tmp/{fmt,clippy,ui-units,e2e-full,current-code-update,supervisor,stress}.log` and `transition-rehearsal.json`. The frozen executable is under `evidence/candidate/`. No real-history response bodies, titles or personal details are added to the repository.

Scores remain **8 / 8 / 8 / 9 / 9 / 9**, weighted **8.40/10**. This closes a real failure-path defect without awarding missing acceptance evidence. Next target: safe installation qualification of the corrected candidate while preserving the production database and backups. The real sign-in test remains deferred by the user; actual sleep/resume and the first-import 400 MB gate remain unqualified. Memory tuning remains stopped. Physical cold-file lifecycle and the other published limitations remain open. No 9, council, commit, push, tag or release is claimed. The live executable and observer remain unchanged.

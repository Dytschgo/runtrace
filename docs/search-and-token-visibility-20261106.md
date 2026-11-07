# Search and token visibility hill climb — 6 November 2026

Scope: improve search on the completed frozen 275,253-record checkpoint, expose recorded cache-write values in the accepted dashboard, and correct partial-usage explanations. Runtime evidence: D:/Code/Runtrace/benchmarks/search-20261106.

## Search evidence

Paired release API measurements used the same frozen data, 512 MB per service and five alternating before/after requests per query, including full stored redacted content. Background production was catching up after a T3 nightly update; this is warm local evidence, not a cold-cache or isolated-CPU guarantee.

| Query | Before median ms | After median ms |
| --- | ---: | ---: |
| test | 1109.97 | 577.41 |
| runtrace (166 matching records) | 1482.76 | 944.55 |
| zzzznosuchphrase82713 (no matches) | 1002.40 | 450.37 |
| a | 1030.04 | 441.38 |
| %test% | 1100.76 | 578.58 |
| Äpfel (no matches) | 972.10 | 443.99 |
| _ | 973.68 | 441.18 |

Every paired full response matched exactly. Full matching ID sets also match for ten real-data patterns, not only the first page. An exact comparison of all fifteen original record columns found zero changed rows. The fourteen API routes otherwise match, with the intentional correction to partial-usage coverage described below.

On-demand lower()+LIKE did not reliably help, and recent-first candidate probing worsened absent/rare searches; both experiments were rejected. Version 2 instead stores DuckDB lowercase of already-redacted JSON in the existing search_text column, then applies LIKE to a lowercased pattern. No additional text column is introduced. Original JSON and complete detail retrieval remain unchanged. Bounded, atomic startup hydration upgrades any other cache version before serving; upserts and retention maintain version 2. Initial frozen cache conversion took 220.4 seconds; serving gains exclude that one-time cost.

The council caught and reproduced an old statistics-dependent Unicode false negative: an ASCII-only v1 cache misses Kelvin-sign/K and dotted-I/I matches that searching original JSON finds. V2 deliberately follows the original-JSON Unicode matching contract. An isolated ASCII-only regression protects that correction; mixed Unicode, accents, sigma, sharp-s, emoji, NUL, wildcard and backslash cases are also tested. The seven ordinary paired comparisons are separate from this intended edge-case correction. DuckDB's [ILIKE implementation](https://raw.githubusercontent.com/duckdb/duckdb/v2.0.0/src/function/scalar/string/like.cpp) and [case conversion](https://raw.githubusercontent.com/duckdb/duckdb/main/src/function/scalar/string/caseconvert.cpp) supplied the source evidence, with runtime tests establishing behavior on the installed engine.

A complete older-cache snapshot restored 275,336 records and rebuilt v2 in 121.047 seconds within the existing 4 GB offline budget. Every restored row has the correct cache version and lowercase value. Purges precede hydration; retention clears derived content with original captured content. Normal production remains at 512 MB.

## Token display and meaning

Models, Overview and Projects show cache-write token values with the count of turns on which the normalized field is recorded. Zero remains known; absence remains unknown. The models ledger hides an empty zero-of-zero denominator. CSV coverage export remains a future refinement.

turns_with_usage now counts any recorded input/output/cache/reasoning field, including known zero and partial observations. The old total-is-known test incorrectly labelled nine model groups as lacking some or all usage. Totals still require complete input and output; cache-read/cache-write values are input subsets and reasoning is an output subset.

The summary labels totals as complete-turn tokens and explains why input can exceed them. Partial-only summaries use the normal unknown marker; charts exclude turns without complete totals rather than drawing them as zero. Model shares fall back explicitly to runs when complete totals are unavailable. Field-specific missing-value text avoids claiming no usage exists when another token field is known. Data Quality, Activity and thread/project usage counters distinguish partial observations from missing totals.

Current upstream Codex code omits unavailable cache-write deltas; historical normalized zeros alone do not prove direct provider provenance. Coverage therefore says recorded for or recorded, rather than claiming a provider reported the field.

## Council and checks

Two independent Codex technical/privacy reviewers reviewed source and evidence. Opus 5.5 independently reviewed dashboard source and actual desktop/mobile screenshots, preserving the established dark ember direction. Opus blocked on misleading partial-total copy and an unexplained complete-total/input difference. Those fixes are implemented along with the related field labels, recorded-field denominator, partial-only chart behavior, accessible unknown marker, and scoped right alignment. Opus explicitly required no further visual review for the fixes; the coordinator rechecked them with rendered tests.

The storage reviewer required the ASCII-only Unicode probe and full v1 snapshot restore; both passed. All council findings and remaining limits are recorded here, rather than translating delivery milestones into a product-quality score.

Validation: 46 Rust tests passed; fmt/clippy with warnings denied passed; frontend build and 94 unit/component tests passed. All 40 browser journeys were verified: the first run passed 37, then two test-fixture/selector defects were corrected and passed on rerun. An additional cache-only model/Overview regression also passed. The conversation fixture now proves captured conversation exists instead of assuming every new primary thread has completed. Browser checks include eleven pages, axe/mobile overflow, real API values and a partial-only model state. Local screenshots use Playwright's portable output path, configured under D: for this run.

The service was stopped at this continuation's first health check, with no fatal error at the end of retained logs. It was restarted. A new T3 nightly (0.1.8-nightly.20261106.4275) invalidated source-version caches; that catch-up completed 34/34 projects with zero project errors before deployment. The reason for the earlier process stop is not established. Automatic process startup/restart remains unfinished.

Deployment and final health evidence are appended after the upgrade. Source remains uncommitted; T3 source data is never modified. Event cursors, remote collection, live quota history, cold eviction and long-duration capacity testing remain incomplete.


Deployment completed with a stopped database+WAL/config/binary/dashboard backup at D:/Code/Runtrace/backups/pre-search-v2-20261106. Offline live cache conversion took 181.826 seconds. Installed binary and every current dashboard asset match the tested artifacts. API12reads+4rejections and MCP20tools/scope/database-identity checks passed. Three targeted browser journeys passed on the installed app; 60 alternating preview/full bulk requests over a healthy collection cycle had zero failures. Final health:34/34synced,zero project errors,zero missing thread relationships,unchanged pass7625ms. Collection remains running.

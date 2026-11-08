# Dashboard design

The Runtrace dashboard is a local analytics app for one developer reading their own T3 history. It answers three questions: what ran, where it went, and what the record cannot tell you.

## Design decisions

**Solid is measured, hatched is missing.** This is the product's one visual rule. Any null renders as the same hatched mark with a reason on hover and for screen readers. The same split appears in coverage bars, open-ended agent bars and quality badges. Nulls are never summed or shown as zero.

**Gaps are computed, not written down.** Nothing says "tokens unavailable" globally. Token panels add up only what providers reported, show how many turns reported usage, and name any model whose turns reported none. On a backend with no usage, the same components fall back to a stated gap.

**A provider turn is not a model call.** `calls` stays null, and turns are never shown under that heading. Every token surface says "per provider turn".

**Agent trees use recorded edges only.** An edge needs an agent's `child_thread_id` or a thread with `relationship_to_parent: subagent`. Forks, titles, timing and `root_thread_id` never create an edge. A parent that was not imported is reported and no placeholder is drawn. A link that would close a loop is not drawn. Lineage is read per project, so a time or model filter cannot orphan a child.

**Time-compressed agent waterfall.** Trees can span days while runs last seconds, so idle gaps are shortened and marked. A true time axis would make most bars invisible. Missing end times are hatched stubs, not implied durations.

**URL state.** Page, filters, sort, paging, selected root, node and tool call all live in the URL, so any view can be linked and survives reload. The API rejects unknown parameters, so page-only keys are never forwarded.

**Client analysis is bounded and labelled.** Threads, agents and provider turns are read whole. Tool calls show the newest 1,000 at once, read the rest automatically up to 10,000 total, and above that wait for "Analyze all". Every partial view says what share it read.

**Visual system.** Pure black and type-led, with hairlines instead of boxes. One trace line is the recurring motif: it draws itself in the logo, rises across the main chart and runs as a sparkline on each thread. White is the only interface accent, so colour always means a model or a status. Geist and Geist Mono are bundled locally. Selected in design round 3; the reference is `docs/design-exploration/r3/fable-style.html`.

**Models carry their provider's logo and company colour.** OpenAI is white, Anthropic orange, xAI dark blue, Meta light blue and Google green. A provider's models are steps on that one scale, in all-time token order, so filtering never repaints a model, and a model with no reported usage cannot take a step from one that draws a line. Steps of one scale are close on purpose, so the name beside each logo and hover isolation tell them apart. On a window of up to a month the chart draws every model. A longer window draws eight lines and folds the rest into a dashed gray Other, and chosen rows are always drawn. Logos are bundled, and identify the provider only. Status colours always carry an icon and a label.

**The time slider is the main control.** Two handles over real prompts, on every page that filters by time. A drag that starts on the bare track pulls the nearest handle, and a press inside the band carries the whole window. A press that does not move changes nothing. 7d opens on the last five weeks of the track and 30d on the last four months, so the window is a band you can grab; one button shows the whole history. Arrow keys move one bar. The track shows days, and zooming to a window of two weeks or less turns its bars into hours. The full unzoomed span is no filter at all, so older threads with no prompts still count. A window reaching now stays open so new records join it. Ranges go from one hour to thirty days.

**The Overview answers in any cut.** The same turns can be grouped by model, provider or project, measured as all tokens, one token type or provider turns, and bucketed from five minutes to a week. A turn with no recorded model still counts for its provider, because the agent that ran it is known. Chart styles are lines, stacked and running total. Compare draws the same length of time just before as a dashed line, and any window with history before it shows a percentage change. Drag across the chart to zoom. A click pins the reading, with a button to open its period (the table view has the same as buttons), so a click never changes the window by accident. Step to the same length of time before or after with the arrows or [ and ]. z and the zoom-out button go back one step: to the window a period was opened from, otherwise to the next longer preset. A resolution too fine for the window is switched off, and one chosen by link stays lit while the chart says what it draws. A change too unreliable to show says "not compared". Zooming the track only changes what the track shows, never the numbers. Providers can be pinned in focus, threads can be sorted by the most tokens inside the window, and the chart downloads as CSV. A window in which nothing ran reads as a real zero, while a measure a provider did not report stays hatched.

**One source for the headline, list and chart.** All three are summed from the same turns, so they cannot disagree, and they follow a held handle without a request. The stats dim until the service answers. The history is read once, then only the newest page each minute, so a window reaching now keeps up by itself. The service's own totals are used only when its turns are unavailable or cut short.

**Clock changes.** Sub-day buckets count from local midnight and stop at the day's real end, so a 25-hour day loses nothing. A test covers this in several time zones.

**A bucket that ran but reported nothing is not a zero.** The line breaks there with a hatched tick, the table says Not reported, the CSV leaves it blank, and the tooltip names what ran, including groups with no line of their own. A bucket where only some turns reported is a lower bound and reads as ≥. A model that reports some fields but no complete total, such as Muse, is described that way rather than as having no usage. Rows say how many of their turns contributed.

**Motion.** The logo draws once, the page rises in order, numbers count, and the trace rises from the left on load and whenever a preset, filter or new cut creates a new view. A window chosen by dragging is already on screen, so it does not replay. `prefers-reduced-motion` gets the finished state with nothing running.

**Charts.** The Overview's trace is plain SVG, one line per model on a shared axis, so it can follow the slider without a chart library re-render. Recharts draws the other time series. Ranked lists are HTML, because long model names wrap and rows can link. Every chart can switch to a table of the same numbers. Tooltips are shown on hover only; the table is the keyboard path. The heatmap is one tab stop with arrow-key reading.

## What is known

These rules hold on every view, table and download of the Overview.

- Time that has not happened, or that nothing captured, is unknown and never zero. A window ending in the future reaches now and compares equal elapsed time. What is known runs from the first record of all, whatever is filtered, to the last capture. A stretch of 10 days or more with no records inside that span counts as not captured, and is hatched too. A window wholly outside what is known says so and is hatched, one part way in stops its axis at the edge, and inside it a zero is a real zero. A bucket only partly in the window or still in progress is shaded.
- A sum that leaves anything out is a lower bound and reads `≥`, in the headline, the ranked rows, tooltips, the period before, tables and the CSV. A running sum stays a lower bound from the first missing value on, and keeps what it already measured.
- A bucket where everything was silent breaks each line through it, including the compare total.
- A project's colour comes from its id alone, so nothing can change it. There are more projects than colours, so when two on one chart share a colour the later id is dashed.
- Focusing a line changes which lines show, never the scale.
- Token usage found only in the agents' session logs, from before T3's current database, is stored as hourly usage per session and model. It adds to every token total, but it is never counted as a provider turn.
- Every page opens on the last 7 days, so moving between pages never changes what is counted. Search looks through everything. The rest of the history loads in the background. "All" is a choice, kept in the link. Clear takes away the scope and keeps the time chosen; a second Clear puts the time back to the default.
- On the Overview the rows are the filter. Every model and provider stays listed and ranked by use, any number can be chosen, and the whole page follows the selection. Turns that name no model keep their rank in the list, hatched, so the shares add up to the whole. They stay off the chart until asked for. The list is one tab stop, and the arrow keys move along it.
- A chosen provider is counted by the service, which works out each record's provider the same way the rows do: from the model name, or from the agent that ran it when no model is named. So a provider's tiles are exact, not lower bounds.
- Groups with no turns in the window stay listed, folded under one button so the ones that ran stand out. A chosen one stays in view.
- The Quota page opens with one line: the windows that are nearly full or on pace to fill before their reset, marked as projections, or a plain statement that none are.
- The Delegation panel lists the busiest delegating threads in the window, each a link straight to its tree.
- Provider turns come from the service lean: only the fields a chart or list reads. The fields every chart needs are stored as columns, so no aggregate reads the JSON document.
- Every list page reads a stored list view of each record (the document without its full text, plus a 512-character preview) instead of the whole document. A page of 1,000 tool calls went from about 740 ms to about 100 ms on the service. Full text is still fetched on demand.
- The Models page gets threads and sub-agents per model with the model list, in one query, instead of a query per model.
- Data Quality's tool field coverage and redaction counts come from the service over every record, not a sample of the latest 1,000 calls.
- The Projects list shows each project in the colour it has on the Overview chart, which comes from its id alone.
- Tokens by type are summed from turns that reported a total, so the parts add up to the headline. Turns that reported parts but no total are counted and named beside them.
- Quota pace is a projection from a window's own readings over the last fifth of its length, at least an hour and at most a day, and is always labelled as one. Readings from another reset are never mixed in. A window at 80% or more is marked.

## Performance

Measured cold, at 1440 wide, on the full history of 34 billion tokens.

- Each service request reads on its own database connection, so requests run side by side instead of in line behind one lock.
- A page of previews may hold up to 20,000 rows. Reading stored records costs about the same for 500 rows as for 20,000, so the dashboard asks for 5,000 at a time and the whole turn history arrives in one or two reads. Full content stays in pages of 500.
- The service's database memory budget is 2 GB, so those reads can run together.
- The overview asks for its chart data first and the panels further down straight after, and it ships with the app rather than as a file loaded later.
- React has a chunk of its own, so only pages with charts download the chart library.

| | Before | After |
| --- | ---: | ---: |
| Overview headline and chart | 1.45 s / 2.80 s | 0.47 s |
| Overview fully loaded | 6.9 s | 2.0 s |
| Requests on open | 64 | 18 |
| Whole history, cold | 7.1 s | 1.5 s |
| Threads list | 2.4 s | 1.0 s |
| Biggest thread's story | 11.2 s | 2.5 s |
| Script downloaded by the overview | 887 KB | 498 KB |

## Pages

| Page | What it is for |
|---|---|
| Overview | Total tokens, models with share, tokens per day by model, totals, tokens by type with coverage, weekday-by-hour rhythm, recent threads with sparklines, top tools, delegation |
| Activity | Peak hour, busiest day, weekday-by-hour heatmap, daily prompts, paged event feed |
| Models | Ledger of tokens, turns, usage coverage, cache share and latency per model; chart by tokens, turns or threads |
| Projects | Tokens and counts per project; per-project detail with models, branches and threads |
| Threads | Title and type filters, sort, paging, tokens per thread. Detail has facts, sub-agents, provider turns, runs and the timeline |
| Agent Trees | Delegating threads ranked, keyboard tree with waterfall, node detail with full task and result |
| Tool Calls | Failure rate, shell exit codes, latency percentiles per tool, filterable calls, linkable call dialog |
| Quota and Resets | Explicit unavailable state today. Renders snapshots and whatever window fields the API sends |
| Storage | Records by kind, database size, stored text, span, maintenance commands |
| Data Quality | Usage by provider, field coverage measured from records, quality by kind, redactions, known gaps |
| Settings | Timezone, page size, density, service health, capture instances, privacy commands |
| Search | Redacted content search with highlighted match, reached from the search box |

Accessibility and responsiveness: skip link, focus moves to the new heading on navigation, roving focus in the tree and heatmap, slider handles with keyboard support and spoken dates, native dialogs, labelled scroll regions, `aria-sort`, reduced-motion opt-in, and an icon row that scrolls sideways below 760px, with secondary filters behind one button.

## Backend compatibility

| If the service... | The dashboard... |
|---|---|
| Has no provider turn or token fields | Hides those columns and tiles, and states the gap once |
| Rejects `include_content` | Retries without it |
| Fails `/usage/projects` | Uses per-project overview counts, and sums tokens from provider turns |
| Fails `/usage/machines` | Reads instances from threads |
| Fails `/storage` | Keeps record counts from the overview and marks sizes unknown |
| Fails a large scan page | Retries smaller, then keeps the rows it has and marks the scan partial |

A model filter on Tool Calls assumes tool rows carry `data.model`. An older backend would return no rows for it.

## Changed files

Everything is under `dashboard/`, plus this file.

- `src/lib/`: API client and scans, filters, URL state, formatting, entity mapping, analytics, tree logic, settings, data hooks
- `src/components/`: shell, UI primitives, data table, charts, token panels
- `src/pages/`: one file per page
- `src/styles/`: tokens, base, app
- `tests/dashboard.spec.ts`, `tests/states.spec.ts`: live and mocked browser journeys
- `src/**/*.test.*`: unit and component tests
- `vite.config.ts`, `playwright.config.ts`, `tsconfig.json`, `index.html`, `package.json`, `public/icon.svg`

Tailwind was removed because it was unused, and `@testing-library/*`, `jsdom`, `@axe-core/playwright` and the two Geist packages were added.

The overview browser test used to write `../docs/screenshots/overview.png`, which this work does not own. It now writes `dashboard/test-results/overview.png`. The README screenshot still shows the old design and needs refreshing by the owner of that file.

## Checks

```
cd dashboard
npm run build
npm test
RUNTRACE_BASE_URL=http://127.0.0.1:4310 npx playwright test
```

`RUNTRACE_BASE_URL` selects the service under test. `RUNTRACE_API` points `vite preview` at another backend, so a build can be checked without replacing a deployed one.

## Remaining API needs

- `kind` filter on `timeline`: the Activity feed can only filter kinds within a loaded page.
- Per-day token and turn aggregates by model: the chart reads every turn, which will not scale forever.
- Total row count in list envelopes: paging totals come from the overview today.
- Thread filters for title and type, so filtering need not read all threads.
- Distinct errors for invalid input and internal failure: every failure is currently a 400 `invalid_query`, so the UI cannot tell a bad date from a failed query.
- Archive size in `/storage`.
- A higher `memory_limit_mb`: at 128 MB, `/usage/*` and some `tool-calls?limit=500` pages return 400 even on a 20 MB database. At 2048 MB the same requests succeed.

## Root integration after Opus delivery

The dashboard is deployed under D:/Code/Runtrace/dashboard/dist and passed the production-data browser suite. The normal DuckDB budget is 512 MB, backed by typed aggregate caches; backend failures now have distinct error categories. Project/thread counts come from one usage aggregate without per-project request fan-out. Tool rankings query all matching stored calls through usage/tools; content charts remain explicitly bounded. Data Quality can expand content analysis and displays incomplete backfill, committed project progress, checkpoints and scoped errors. MCP proxying verifies database identity. The README screenshot was refreshed from the installed dashboard.

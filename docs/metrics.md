# Metrics and limitations

Each metric describes observed source coverage. Missing values remain null; missing historical activity is not counted as zero. Behavioural proxies are not objective work-quality scores.

| Metric | Formula and required fields | Null handling, quality and example |
|---|---|---|
| Imported prompts / answers | Count proven terminal user / assistant messages | Partial historical coverage. Five user rows means five observed messages, not five root tasks. |
| Hourly prompts | Count prompt rows by source creation hour, displayed in configured timezone | No invented pre-capture history. Source UTC hours are regrouped for Europe/Zurich display. |
| Runs by model | Count recorded runs grouped by requested selection | Resolved model remains unknown. Lifecycle counts may include active runs. |
| Provider turns / model calls | Count terminal provider turns; individual model calls unavailable | Turns are never relabelled calls. Ten turns can contain an unknown number of calls. |
| Input / output / cached / reasoning tokens | Sum non-null normalized per-turn fields from turnTokenUsage | Show reporting-turn coverage. Cached input is an input subset; reasoning is an output subset. All null gives null. |
| Total tokens | Input + output only when provider usage is complete | Do not add cached/reasoning subsets again. Input 100, cached 60, output 20, reasoning 5 gives 120. Partial usage gives null total. |
| Context reuse | Cached input / input for reported observations with denominator > 0 | Descriptive coverage only; provider semantics differ. 40/100 = 40%. |
| Median / P95 latency | Median / continuous 0.95 quantile of observed completed provider-turn duration | Null timing excluded, not zero-filled. Not first-token latency or model-call latency. |
| Per-tool latency / failures | Duration quantiles and failed/status-known counts grouped by tool | Server aggregates include all matching stored calls; content charts may use a labelled bounded scan. Two known durations 100/300 ms have median 200 ms. |
| Agent depth | Count explicit subagent ancestry edges below a root | Cycle/missing parent gives unresolved lineage; forks do not add depth. Root-child-grandchild depth = 2. |
| Agent fan-out (observed) | Count explicit direct child edges per parent | Tree view shows recorded fan-out, not complete provider-native internal activity. Four child edges = observed fan-out 4. |
| Subagent busy time | Sum known child elapsed durations | Overlapping agents count independently. Two concurrent 1-minute agents give 2 busy minutes, not 2 elapsed minutes. |
| Unused at reset | Final valid matching pre-reset remaining percentage | No snapshots gives null. 20% at 09:59 before 10:00 means 20%, not next-window 100%. |
| Complete quota window | Boundary-near samples plus bounded internal gaps across the matching window | Tested primitive; otherwise partial/unavailable. No live windows are collected by this adapter. |
| Quota utilisation | 100 - unused percentage before reset | Complete-window comparisons only. 100 - 20 = 80%. |
| Wasted reset thresholds | Count complete windows with unused percentage strictly above 10/25/50/75 | 30% unused increments only 10 and 25. No historical reconstruction. |

The following remain specified rather than fully implemented:

- Subagent amplification = all descendant model tokens / root model tokens. Requires comparable token scopes and explicit run links; denominator > 0. Example 200/100 = 2.0. Main-agent usage must not be allocated to native children without evidence.
- First-pass completion proxy = completed primary threads without an observed corrective follow-up / completed primary threads. Requires reliable correction classification, currently unavailable. Example 8/10 = 80%; absence of a correction is not proof of quality.
- Tool intensity = tool calls / individual model calls. Calls are unavailable; run/turn counts must not be substituted. Example 6/3 = 2.0 only with actual calls.
- Agent fan-out per primary run = direct child agents / primary runs. Requires triggering-run linkage beyond the thread graph.
- Quota burn rate and remaining-at-reset projections require live samples, sufficient time span and explicit confidence. None are shown as observed fact.
- Cost requires complete compatible tokens and configured pricing. No price or cost is fabricated.

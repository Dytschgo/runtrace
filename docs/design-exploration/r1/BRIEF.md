# Runtrace design exploration, round 1

Runtrace is a local analytics dashboard where one developer reads their own AI coding history: which models ran, how many tokens they used, what tools and sub-agents they called. The current UI is a sober dark table-and-chart page (`docs/screenshots/overview.png`). The owner thinks it looks bad and wants an **ultra-modern, high-end, almost cinematic** interface.

Mood reference: `C:\Users\DylanFerraro\.t3\userdata\attachments\c088e951-cd47-4e3f-8ae1-6f486ce9b2cf-de523067-a33c-4e5a-9d0f-1cc0c124e0d3.png`. Charcoal surfaces, amber light, rounded pill bars, dial gauges, glowing orbs, big thin numerals, icon-only rail. Take its level of finish, not its content. Its text is gibberish. Only concept A follows its palette closely.

## The owner's requirements

1. **Models are coloured.** Every model has its own colour, used identically everywhere it appears, plus its icon.
2. **Uses icons.** Icons replace words wherever the meaning survives.
3. **Very little text.** Short labels, big numbers, details on hover.
4. **A slider for time.** This is the main control of the page, and it should feel great to drag.
5. **A great logo.** It should look like a real brand mark.
6. **Animations.** Clearly animated and alive.

## What to build

One screen: the **Overview** page, as a mockup. Hardcoded data, no build step, vanilla HTML, CSS, SVG and JS.

Write exactly these files in `docs/design-exploration/r1/`, where X is your concept letter:

| File | Content |
|---|---|
| `concept-X.html` | Self-contained page, 42KB maximum including data |
| `logo-X.svg` | The mark alone. Starts with `<svg`, has a `viewBox`, no text, script or remote references |
| `meta-X.json` | See the schema below |

Change nothing else in the repository. No git commands. No sub-agents. Do the work yourself.

### Stage

The page is a fixed **1440×900** stage: `html,body{margin:0;width:1440px;height:900px;overflow:hidden}` with an explicit background. Nothing scrolls, and nothing is clipped at the edge.

### Must contain

| Element | Requirement |
|---|---|
| Logo | Mark and wordmark "Runtrace" in a container with `data-logo`, mark as inline `<svg>`. Animated once on load. |
| Icon navigation | 12 items in a `<nav>`: Overview, Activity, Models, Projects, Threads, Agent Trees, Tool Calls, Quota, Storage, Data Quality, Settings, Search. Use `<a>` or `<button>` with `aria-label` and a tooltip. No visible labels unless your concept truly needs them. Clicking moves the active indicator with animation. |
| Time slider | Controls a window over the 35 days of data. Mark the focusable handle(s) with `data-time-slider` (a native range input, or `role="slider"` with `aria-valuenow`, `aria-valuemin`, `aria-valuemax`, `aria-label`). Arrow keys must work. Two handles are preferred. Every number and chart recalculates while dragging. |
| Token total | Hero number, recomputed for the window, counting smoothly. Marked `data-readout`. |
| Model breakdown | At least the 8 models with reported tokens plus the 2 with none. Each has an element with `data-model="<id>"`, its colour, its icon, its share. Hovering or focusing one highlights it across every chart and dims the others. |
| Tokens per day by model | Any form that fits the concept, stacked or streamed by model, in model colours. |
| Stats | Prompts, provider turns, threads, sub-agents, tool calls. Icon plus number plus at most one word. Each marked `data-readout`. All recompute for the window. |
| Activity texture | The weekday-by-hour prompt heatmap, in a form that suits the concept. It is all-time data, so give it a small "all time" mark. |
| Tools | Top tools with icons, calls and failure share. All-time data, same small mark. |

### Data rules, which are not negotiable

Inline `data.js` unchanged, as exactly `<script id="rt-data">window.RT=...</script>`, then read everything from `RT`. These are real numbers, so do not invent any.

- `RT.days` rows follow `RT.dayColumns`. Window totals are sums over rows.
- Total tokens for a window = `otherModelTokens` + all model columns.
- `grok-4.7` and `muse-wonder-1.0` have `tokens: null` in `RT.models`. Their day columns read 0, but that is **missing, not zero**. Show them with a hatched mark and a "no usage reported" tooltip. Never show 0 or a share for them.
- **Solid is measured, hatched is missing** is the product's one visual rule. Keep it in your concept's own style.
- Never show cost, quota, money, model calls, regions, world maps, users or any other metric that is not in `RT`. Cost and quota are not captured.
- A turn is a "provider turn", never a "model call".
- Show the time zone once, tersely, or leave it in a tooltip.
- `RT.projects`: use only the first four if you use projects at all.

Format big numbers compactly (`22.0B`, `192K`). Use tabular figures or a mono data font for changing numerals, so nothing jitters while dragging. Check that the font really has tabular figures.

### Icons

Use real Lucide paths. They are at `dashboard/node_modules/lucide-react/dist/esm/icons/<name>.js`. Copy the path data into a compact sprite or JS map. Use `RT.models[].icon` for the model icons (`sun`, `moon`, `sparkles`, `sunrise`, `feather`, `music`, `book-open`, `leaf`, `zap`, `wand-sparkles`). Do not use provider brand logos.

### Text limit

At most **130 visible words**, including model names. Minimum text size 12px. Put explanations in tooltips.

### Logo

This is judged on its own, large and small, on the concept's background. Make a real mark that a design studio would be proud of: one clear idea about **a run leaving a trace**, built on a geometric grid, readable at 16px and at 256px. Avoid a letter in a rounded square, generic hexagons, sparkles, brains and circuit boards. Do not reuse the current orange R. Choose a wordmark treatment in your display font. Do not copy any existing company's mark.

### Motion

Motion must be obvious and high-craft.

- Load choreography of at most 1.4s. The logo draws, panels and charts arrive in order, and numbers count up.
- While dragging, charts and numbers follow the handle within a frame. Transitions tween, nothing jumps.
- Hovering a model visibly reacts across the page.
- One signature ambient motion that belongs to this concept. Pause `requestAnimationFrame` when `document.hidden`.
- Prefer `transform` and `opacity`. Keep a filter or blur effect only if it stays smooth.
- `prefers-reduced-motion: reduce` gets a complete, static, fully readable version with no looping animation.

### Accessibility

Visible focus rings. Text contrast at least 4.5:1 and model colours at least 3:1 on their surface. Icons are decorative only if a text name exists nearby or in `aria-label`.

### meta-X.json

```json
{
  "id": "R1-X",
  "name": "Two words",
  "by": "codex or grok, and the model id",
  "pitch": "One sentence, 15 words maximum",
  "tradeoff": "One honest sentence on what this gives up",
  "fonts": { "display": "Family", "ui": "Family", "data": "Family" },
  "fontWhy": "One sentence",
  "palette": ["#bg", "#surface", "#text", "#accent"],
  "modelColors": { "gpt-6.1-sol": "#hex" },
  "logoIdea": "One sentence",
  "sliderIdea": "One sentence",
  "signatureMotion": "One sentence"
}
```

Font family names must match the loaded CSS family exactly.

### Verify before you finish

Run `node docs/design-exploration/r1/_tools/check.mjs X` from the repository root. It loads your page at 1440×900 in Chromium, checks the contract, drives the slider by keyboard and writes `docs/design-exploration/r1/shots/X.png`, `X-slid.png`, `X-reduced.png`. Fix every failure. **Then open and look at the screenshots** and fix what looks wrong: overlaps, cramped labels, empty corners, unreadable text, weak hierarchy. A passing check does not mean it looks good. Keep iterating until you would show it to a design director.

Do not hand-tune the checker, and do not edit it.

End your final message with the check's `pass` value and one line on what you are least happy with.

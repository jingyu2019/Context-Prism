# t8 review (round 3) — is measurement free, and do both tool-call spellings share one definition?

Reviewer: `review` (independent, round 3). Scope: t7's two repairs only (R-004, R-003). F1, R-001 and
R-002 were passed in round 2 and were checked only for disturbance. Repository read only; the one
verification command was `npm test`.

Verdict: **pass** — both repairs are real, the counterfactual cannot reach a model, the two capture
spellings now resolve to a single exported function, and the round-2 guards are intact. Two low,
non-blocking findings (R-005, R-006).

---

## 1. R-004 — measurement costs no model calls and is opt-in

**Counterfactual cannot summarize.** `engine/engine.js`: `_savedTokens` (`:551`) and
`_savedTokensAsync` (`:565`) both call the control assembly with `summarizer: null` forced (and
`measureSavings: false` to stop recursion). The async control goes through
`compressItemsAsync(items, budget, query, { summarizer })`, which calls the summarizer only behind
`if (summarizer)` and otherwise falls back to extractive `compressChunkToFit`
(`engine/compression.js:71-95`). With `summarizer: null` there is no path from the counterfactual to
a model. The new test `R-004: the counterfactual never calls the summarizer` constructs a fresh
engine per probe (so a shared compression cache cannot mask a call), asserts the fixture really
summarizes (`without.calls >= 1`) and that enabling measurement adds exactly zero calls. The
captain's raw counts (pre-repair 6 vs 3, post-repair 3 vs 3) are consistent with this structure; I
did not re-run that probe — I ran only `npm test` — but the zero-added-call property is guaranteed
by the forced `null`, not by a cache-dependent measurement.

**Off by default.** `measureSavings = false` is the default in both `buildContext` (`:281`) and
`buildContextAsync` (`:383`). The per-step prompt path passes `measureSavings: false` explicitly in
both branches (`lib/index.js:893` llmSummarization, `:907` sync); only the diagnostic
`context_prism_build` tool opts in (`lib/index.js:247`). The test wraps `engine.buildContext` and
asserts 1 assembly by default vs 2 with the opt-in.

**Honest where displayed.** With the opt-in on, the round-2 equality test was updated to pass
`measureSavings: true` and still asserts `dupSavedTokens === independently rebuilt
material(control) - material(window)` (`test/presence.test.js:230-251`). Off, the value reads 0
while `dupDroppedCount`/`dupCandidateTokens` still report the filter's work; the plugin prompt path
asserts `dupDroppedCount >= 1` and `dupSavedTokens === 0` (`test/presence.test.js:748-750`).

## 2. R-003 — one spelling, two capture paths

`toolCallText(block)` is now exported from `engine/presence.js:191` and imported by
`engine/session_events.js:20`; both capture paths use it: `blocksToText` for a message whose content
array carries a `tool-call` block (`:37`) and `describeEvent`'s `tool/call` branch (`:150`).
Presence's `contentToText` uses the same function (`:221`), so message capture, event capture and
the live surface are one definition — a future drift would require editing the shared function, not
matching two strings by comment. The old hyphen spelling `[tool-call name]` is gone from capture.

The new fixture both earlier suites lacked is present: `R-003: a chunk captured from an assistant
message carrying a tool-call block is not re-injected` (`test/presence.test.js:508`) builds an
assistant message whose `content` array contains `{type:"tool-call", name, arguments}`, captures it
via `captureSessionEvents`, asserts the stored chunk uses `[tool/call read_file]` (and not the
hyphen spelling), asserts `presence.contains(toolChunk.content) === true`, and asserts the resulting
window is empty (`text === ""`, `dupDroppedCount >= 2`). The paired test at `:487` asserts the three
spellings are byte-equal (`blocksToText` message path, `describeEvent` event path, `toolCallText`).

## 3. Round-2 scope not disturbed

`hasSubstantialToken` (`:107-126`), `matchesWithBoundaries` (`:150`), `indexedChars`/`chars` and
`haystackChars` (`:256`, `:305-307`) are unchanged; the presence predicate is still applied before
compression on both lanes (`engine/engine.js:301/307` and `:401/407`); `test/dedupe_falsification.test.js`
is still byte-identical to t2's out-of-tree control copy. `npm test` → **150 tests, 150 pass,
0 fail** (113 pre-existing + 27 presence + 10 falsification).

## Findings

| id | severity | problem | required fix |
| --- | --- | --- | --- |
| R-005 | low | The shipping report always publishes `dupSavedTokens: 0` because the hot path never measures; nothing in `lastInjection` distinguishes "not measured" from "measured zero", so a report reader can conclude the feature saved nothing (while `dupCandidateTokens` shows drops). Acceptance explicitly allows 0 here; this is a naming/clarity issue, not a wrong number. | Publish a `dupSavedMeasured: false` flag beside it, or omit `dupSavedTokens` when it was not measured. |
| R-006 | low | On the async `llmSummarization` path the control is deliberately forced extractive, so an opt-in saving measured there would compare an LLM-summarized window against an extractive control (the packed item set can differ). No display path opts in async today, so nothing misreports now; the tradeoff is worth documenting rather than leaving implicit. | Document the unit ("material tokens of packed items, measured with extractive compression") or restrict measurement to the sync diagnostic path. |

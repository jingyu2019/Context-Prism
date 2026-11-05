# t6 review (round 2) — presence filter: do the four repairs close their findings without loosening the predicate?

Reviewer: `review` (independent, round 2). Reviewed work: t5's repair of F1/F2/R-001/R-002, at the
current bytes. A round-1 pass on older bytes is not carried over. Repository read only; the one
verification command was `npm test`.

Verdict: **pass** — the four findings are closed for their stated scope, the predicate was not
loosened, and the frozen falsification suite is byte-identical and green. One new medium finding
(R-003) records a remaining capture/presence spelling drift on the message path.

---

## 1. F1 — tool-call blocks count as request text (`engine/presence.js`)

`contentToText()` now projects `{type:"tool-call", name, arguments}` through `toolCallText()`:
`[tool/call ${name}] ${serialized}`. The serialization rule matches capture's `describeEvent`
`tool/call` branch (`engine/session_events.js:142-147`): `args == null` → `""`, string → as-is,
anything else → `JSON.stringify`; both `.trim()`. Absent/undefined/empty args yield
`[tool/call name]` on both sides; a non-string object is JSON-stringified on both sides. A chunk
captured from a tool/call event strips its `[tool/call …]` header into the arguments body, which is
a substring of the live projection, so the chunk is judged present and dropped. The new test
`a chunk captured from a tool/call event matches the live block that produced it`
(`test/presence.test.js:100`) imports the real `describeEvent` and asserts the exact symmetry —
if either spelling moves, it fails. The tool-call-heavy session test (`:384`) first reproduces the
bug state (text-only surface → tool-call chunks re-injected) so its zero-residual assertion is not
vacuous.

**R-003 (medium, new).** Symmetry holds for the `tool/call` *event* chunk, not for a message whose
`content` array carries a `tool-call` block. Capture's `blocksToText()` spells that block
`[tool-call ${name}]` (hyphen, no arguments — `engine/session_events.js:34`), while presence
projects the live block as `[tool/call ${name}] ${arguments}` (slash, arguments). A history chunk
`assistant: … [tool-call read_file]` therefore never matches the live `… [tool/call read_file] {…}`
text: it is judged absent and re-injected, silently, on every turn it is retrieved. Both new test
fixtures keep assistant messages text-only and tool calls as separate events, so neither suite
exercises it. This errs toward injection (no information loss) and is bounded to assistant-message
chunks carrying tool-call blocks, so it does not falsify F1 as scoped, but the "THIS PAIR MUST MOVE
TOGETHER" invariant in `presence.js` covers only one of capture's two tool-call spellings.

## 2. R-001 — short/common needles and in-word hits (`engine/presence.js`)

`contains()` now applies two guards before searching: `hasSubstantialToken()` requires one run of
>= 4 ASCII (or >= 2 CJK) characters, and `matchesWithBoundaries()` rejects a hit whose start or end
lies inside a longer word. Both directions verified, at both layers:

- short body still injected: `contains("ok")`, `contains("ok")`, `contains("the")`,
  `contains("fix bug")` are all false on a surface containing `the token budget is fine`; at engine
  level `R-001 engine` (`test/presence.test.js:451`) shows a preference chunk whose body is `ok`
  reaching the window while the genuine duplicate is dropped;
- genuine duplicate still dropped: `contains("token")` and `contains("budget is fine")` are true,
  and the same test asserts `genuine-duplicate` is absent from the window.

The boundary rule is not a blanket length floor: `"the quick"` is rejected inside
`the quickest thing` (mid-word start/end), yet accepted at a message start. That message-start
exception is deliberate (a truncated chunk is a literal message prefix, and the 8000-char cut lands
mid-word) and is documented in the helper; it can only match text that literally begins the
message, so it cannot manufacture presence for content that is not in the request.

## 3. F2 — the reported saving is the realised delta (`engine/engine.js`)

`_savedTokens()` / `_savedTokensAsync()` build the same window with `presence: null,
dedupeAgainstPrompt: false, measureSavings: false` and return
`Math.max(0, materialTokens(control) - materialTokens(window))`. So the counterfactual is a real
different assembly: the retrieval cache is shared, but the compression cache key is built from the
filtered item list, so the control compresses a different item set; the recursion is cut by
`measureSavings: false` (the control reports `dupSavedTokens: 0`). `materialTokens` counts
`chunk.tokens || estimateTokens(content)` per item and excludes the Omitted-Memory note — exactly
the units `ContextWindow.report()` uses per item (`engine/models.js:161-167`). The fixture test
(`test/presence.test.js:230`) independently rebuilds the unfiltered window and recomputes
`realised = material(control) - material(window)`, then asserts `dupSavedTokens === realised`,
`realised > 1000`, and `dupCandidateTokens !== dupSavedTokens` (so the assertion cannot pass by
coincidence). The clamp makes a negative impossible. Shipping diagnostics publish
`dupSavedTokens` and `dupCandidateTokens` only; the legacy `dupDroppedTokens` remains on the
window/report as a documented alias of the pool, and the prompt-context test asserts it is not a
property of `lastInjection`.

## 4. R-002 — character accounting (`engine/presence.js`, `lib/index.js`)

`chars` is `indexedChars`, incremented for every normalized message before the cap decision, so it
includes the text that fell past the 4 MB cap into the overflow scan; `haystackChars` reports the
cap-limited haystack alone. The cap test (`test/presence.test.js:158`) asserts `chars` equals the
sum of all three normalized message lengths while `haystackChars <= 40`, i.e. `chars >
haystackChars`. `lib/index.js` exposes both (`diagnostics.presence.chars`, `.haystackChars`) with
the overflow relation documented next to them. The field can no longer be misread as "what fit
under the cap"; it is honestly the whole figure.

## 5. No loosening of the pinned predicate

`test/dedupe_falsification.test.js` is byte-identical to t2's out-of-tree control copy
(`diff -q` against `/tmp/cp_probes/control/...` → identical) and mtime precedes the repairs.
`npm test` → **146 tests, 146 pass, 0 fail** (exit 0): 113 pre-existing + 23 presence + 10
falsification. The falsification suite's own duplication/residual/compaction assertions still hold.
The changes are additive guards (substantial-token, word boundary, tool-call projection), not a
relaxation of "present ⇒ drop": the only accepted widening is the documented message-start prefix
exception, which cannot judge content present that the message does not literally begin with.

## Findings

| id | severity | problem | required fix |
| --- | --- | --- | --- |
| R-003 | medium | Capture's message path spells a `tool-call` block `[tool-call name]` (`engine/session_events.js:34`) while presence projects it `[tool/call name] arguments`. A message-sourced chunk containing that marker is judged absent and re-injected; untested by either suite. No information loss (errs toward injection), bounded to assistant-message chunks with tool-call blocks. | Unify the spelling, or teach `stripFormattingPrefixes`/`candidatesOf` to normalise both `[tool-call name]` and `[tool/call name]` markers; add a message-content-with-tool-call fixture to both the unit and falsification suites. |
| R-004 | low | The F2 counterfactual is a second full assembly on every step where anything was dropped; on the async path with `llmSummarization` enabled it can invoke the summarizer a second time (extra model call/latency) for the unfiltered pool's oversized duplicates. | Note the cost in the config/docs, or gate the measurement behind a debug flag; correctness unaffected. |

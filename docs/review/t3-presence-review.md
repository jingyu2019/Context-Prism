# t3 review — presence-aware injection: is the saving real and is retention preserved?

Reviewer: `review` (independent). Reviewed work: t1's implementation (`engine/presence.js`,
the dedupe path in `engine/engine.js`, `readLiveMessages()` in `lib/index.js`), judged from the
current bytes, not from t1/t2's reports. Repository was read only; the one verification command
was `npm test`.

Verdict: **pass** — the requirement is met in both directions; two low findings, no high or blocker.

---

## 1. The judgement rule (`engine/presence.js`)

**Normalization.** `normalizeForPresence()` lowercases, collapses every `\s+` run to one space and
trims; `null`/`undefined` become `""`. Both sides (live messages and stored chunks) go through it,
so re-wrapped live text and differently-spaced chunks compare equal. No truncation, no stemming —
the comparison stays literal, which is what a prefix match needs.

**Dangerous case 1 — truncated prefix must match.** `contains()` is `haystack.includes(needle)`,
i.e. substring, so a stored chunk that is a truncated prefix of a live message matches:
`index.contains(live.slice(0, 30)) === true` (`test/presence.test.js:37`). The plugin's own
decoration (`user:` / `assistant:`, a leading `[kind | source]` header) is stripped **chunk-side
only** in `candidatesOf()` → `stripFormattingPrefixes()`, so a decorated, truncated chunk still
matches the bare live body; the live request is never weakened. The header regexes are anchored
(`^...[ \t]+`) and exclude `\n`, so `[text](url)` links are left alone. Verified.

**Dangerous case 2 — short common text.** Blank input is refused: `candidatesOf("")` returns `[]`
(after stripping, an empty body still leaves the normalized raw form as a candidate only when the
normalized text was non-empty), and `contains("")`, `contains("   ")`, `contains("\n\t ")` are all
`false` (`test/presence.test.js:65`). Whitespace-only and null-ish text therefore never match
"everything".

Residual false positive (finding R-001): `contains()` has no minimum needle length and no token
boundary. A chunk whose body is a single short word is judged present whenever that substring
occurs inside any live text — e.g. body `ok` matches `token`, `look`, `broken`. This is bounded to
very short chunks and the dropped text is literally already present in the request, so it is a
low-severity imperfection of the substring rule, not a blanket exclusion. The acceptance wording
("must not match everything") holds; the literal "single word" case does not.

**Haystack cap.** The haystack is bounded (`DEFAULT_MAX_HAYSTACK_CHARS = 4_000_000`, projected
size including separators, checked before append). Once a message would pass the cap, `capped` is
set and every remaining message is pushed to `overflow`, which `contains()` scans individually with
the same needle. The fallback therefore gives the same answers as the haystack path — it trades
speed, not correctness. `contains()` also searches the stripped candidate before the raw one, so
both decorated and undecorated chunks are covered.

**Cross-message safety.** Messages are joined with `\u0000`, which normalization cannot produce or
remove, so `alpha` + `beta` in two messages does not match the chunk `alpha beta`
(`test/presence.test.js:88`).

## 2. Where the filter runs (`engine/engine.js`)

`buildContext()` and `buildContextAsync()` compute `_presenceFilter(presence, dedupeAgainstPrompt)`
after `retrieve()` + `prioritize()` and then apply one predicate, `keep(item)`, **before**
`compressItems()`/`compressItemsAsync()` on both lanes: the preference lane is filtered at
`engine/engine.js:301` before its compression, the non-preference lane at `:317-319` before its
compression with the remaining budget. Dropped items are removed from the pool, so the budget they
would have spent goes to survivors — the pre-budget proof in `test/presence.test.js` (baseline
starves two absent chunks, dedupe injects both uncompressed) exercises exactly this.

The filter is inactive — every item kept, zero drops — when `dedupeAgainstPrompt === false`, when
`presence == null`, or when the object has no `contains` function (`:483-486`), so the switch-off
path is the old behaviour, not a different one. The compression cache key is computed from the
**filtered** item list (ids + scores, `_compressionCacheKey`), so a cached result cannot bypass the
filter.

All-duplicate collapses cleanly: no preference section, `compressItems([])` returns nothing, the
Omitted-Memory note is absent (drops are not counted as omissions), so `sections` is empty and
`window.text` is `""`. Both layers assert it: `assert.equal(alreadyThere.text, "")` at the engine
level and `assert.equal(nothing, "")` through the prompt-context path.

## 3. The shipping path (`lib/index.js`)

`buildInjectionText()` takes `context?.agent?.session` (the host session, `lib/index.js:816`) and
calls `readLiveMessages(session)` (`:860`), which probes `typeof session.deriveMessages ===
"function"`, calls it inside `try/catch`, and requires an array. Missing, throwing or non-array →
`{ messages: [], source: "none" }` → empty presence index → `contains` is false for every chunk →
everything stays injectable. That is the conservative degradation: no throw, no loss, only the
saving is forfeited. `diagnostics.presence {source, messages, chars, capped, misses}` and
`lastInjection.dupDroppedCount/dupDroppedTokens` expose which mode ran, so a host that cannot
supply the surface is observable rather than silently "working".

The presence is read from the same session whose events were just captured for this step, and the
empty-window early return (`:895`) is what turns an all-duplicate step into zero injected tokens.

## 4. Retention is asserted, not merely suppression

The compaction case is explicit in both directions:

- `test/presence.test.js:256` — one indexed history chunk. With an **empty** live surface (a
  compaction `replace` removed the message) the chunk is injected
  (`assert.match(compacted.text, /vault key rotates every ninety days/)`, `dupDroppedCount === 0`);
  with the same text on the live surface it is suppressed (`text === ""`, `dupDroppedCount === 1`);
  with an unrelated live surface it is injected again — so the behaviour is not "history off".
- `test/presence.test.js:382` — through the real plugin prompt-context path with
  `session.deriveMessages`: step 1 (`deriveMessages` returns `[]`) asserts the captured message **is
  injected**; step 2 (surface holds only "Understood.") asserts it **is still injected**; step 3
  (surface holds the message) asserts it is not restated.

Both directions therefore have a failing-if-wrong assertion; the retention half is not inferred
from the dedupe half. t2's out-of-tree probes independently show the same shape (`force every chunk
present` breaks "a compaction-replaced message MUST be injected").

## 5. Verification

`npm test` → **141 tests, 141 pass, 0 fail** (exit 0). Baseline was 113; the new suites are
`test/presence.test.js` (18) and `test/dedupe_falsification.test.js` (10).

## Findings

| id | severity | problem | required fix |
| --- | --- | --- | --- |
| R-001 | low | Substring presence has no minimum needle length or token boundary: a very short chunk body (e.g. `ok`) matches inside unrelated words (`token`, `look`), so it can be wrongly withheld. Bounded to tiny chunks; the withheld text is literally in the request. | Optional hardening: refuse needles below a small character floor (well under the 30-char prefix case already tested), keeping the prefix property intact; add a one-word regression test. |
| R-002 | low | `diagnostics.presence.chars` reports only the haystack length, so on a capped host it under-reports the text actually scanned (overflow messages are scanned but not counted). Observability only; presence answers are unaffected. | Add `overflowChars` (or count overflow into `chars`) in `buildPresenceIndex`/diagnostics. |

Neither finding blocks: the saving is real on the shipping path (all-duplicate step → empty
contribution) and the content a compaction removed is still injected (asserted at both the engine
and plugin-prompt-context layers). No blanket history exclusion: history chunks live in the same
retrieval pool and are dropped only when their text is found on the live surface.

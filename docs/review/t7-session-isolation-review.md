# t7 review — session isolation, concurrency safety, scoring fix, docs honesty

Reviewer: `review` (independent). Reviewed work: t5 (plugin wiring) plus the t2–t4, t6
implementation it depends on, at commit `7d01348` (`v0.9.0`, tree clean).
Scope of this review: read the code, not the implementers' claims; every probe was run
out-of-tree on a `/tmp` copy so the repository was never mutated.

Verdict: **pass** — no unresolved high or blocker finding.

---

## 1. The isolation invariant (code read + falsification)

Choke point: `engine/retrieval.js` `retrieve()` filters every candidate through
`isVisibleInScope(hit.chunk, cfg.scope)` **before** scoring, ranking, compression, the
caches and the window. Nothing downstream re-admits a filtered chunk.

Predicate: `engine/models.js` `isVisibleInScope()`
- `session_cursor` → never visible (control record);
- scope `null` → whole index (unscoped CLI/tests; documented);
- project kinds (`preference`, `code`, `file`) → always visible;
- `history` / `trajectory` → visible only when `sessionScopeOf(chunk) === scope` or the
  chunk is unowned (imported corpora / seed data, deliberately project-wide).

Cache keys (`engine/engine.js`):
- `_retrievalCacheKey`: **string**, contains `rev:${index.revision}`,
  `s:${JSON.stringify(scope)}` and `cfg:${JSON.stringify(configFingerprint(config))}`;
  `configFingerprint` carries relevance/semantic/recency/source/priority weights,
  half-life, `topK`, `useSemantic` and `sourceWeights`.
- `_compressionCacheKey`: **string**, contains revision, scope, query, budget and a SHA-1
  of the exact `[id, score]` payload. It does not repeat the weights, and does not need
  to: the payload signature already pins the ranking the compression consumes, so a
  weight change that changes the ranking changes the key, and one that does not change
  the ranking cannot change the compressed result.

Engines: `lib/index.js` `getEngine()` keys the module-level map by
`${backend}:${index}` — never by session. Session identity travels only as the `scope`
argument of a call. `lastProjectRoot` no longer exists; `resolveProjectRoot()` is pure
(session header cwd → workspace registry → cwd), and both HTTP routes and tools resolve a
project per request/call.

Falsification (out-of-tree, each probe reverted afterwards):

| Probe | Result |
| --- | --- |
| A. delete `if (!isVisibleInScope(...)) continue;` | concurrency test **fails**: `round 1: sess-0 window contains history from sess-5, sess-1, sess-2, …` (0 pass / 2 fail) |
| B. restore the old `Math.min(0.999, …)` clamp | parity suite **fails**: `no hit may land on the old 0.999 ceiling`, `SqliteIndex R@10 0.463 below 0.95`, `SqliteIndex order must survive scoring unchanged` (4 pass / 3 fail) |
| C. drop `s:${JSON.stringify(scope)}` from the retrieval cache key only | concurrency test **fails**: `round 1: sess-1 window contains history from sess-0` (0 pass / 2 fail) |

So the three properties that matter are each load-bearing, not merely asserted:
the visibility filter, the scope in the cache key, and the non-clamping score map.

## 2. `normalizeHitScore` (F1) — reviewed as a fix

Current implementation is `magnitude / (magnitude + 1)` on `|score|`, with no per-backend
constant and no clamp.

- **No clamping anywhere.** The only `Math.min` left in the file is the over-fetch bound
  (`topK * 4` capped at `topK + 200`), not a ceiling on relevance.
- **Observed range** −2.9e-6 … −28.8 maps to ≈2.9e-6 … 0.9665, strictly increasing.
  Near the top the curve is not resolution-starved: the derivative is `1/(1+x)²`, about
  1.1e-3 per unit at x = 28.8, versus a double ULP of ~1e-16 at 0.966.
- **The admitted double-ULP tie is a floating-point property, not a curve defect.** For
  x below 2⁻⁵³, `1 + x` rounds to exactly 1, so the map is the identity and loses nothing;
  in the narrow band just above it, dividing by `1 + 2⁻⁵²` perturbs the result by ~0.4 ULP
  at x ≈ 1e-16, so adjacent doubles can land together. Two pairs across 410 hits, with a
  relative gap below the test's 1e-12 threshold — i.e. scores that binary64 cannot
  distinguish in the first place. No correct map into [0, 1) can separate them while
  staying monotone; the alternative is to keep raw scores, which the shared weighting
  formula forbids.
- The parity test is genuinely **order-based**, not threshold-only: it asserts each
  backend's scored order reproduces its own hit order for every query (the clamp falls
  back to the id tie-break and fails this), requires both backends to be good so
  "both bad" cannot pass, and requires at least one natively-agreeing query so it cannot
  be vacuous. Probe B confirms all three assertions fire when the clamp returns.

## 3. The user's requirement, checked at the plugin seam

- **Auto-invoked per session, not per process:** `apply()` registers
  `systemPrompt.context({ name, order, text: provider })` when `cfg.autoInject`; the
  provider is re-evaluated on every host assembly. The host's pre-step fallback path
  calls the same `buildInjectionText()`. Both derive the session from
  `context.agent.session` and pass `scope: sessionIdOf(session)` into
  `buildContext()`/`buildContextAsync()`.
- **Concurrent sessions do not interfere:** the concurrency test drives eight sessions
  through `capture → buildContext` with `Promise.all`, asserts `maxInFlight === 8`,
  re-checks the count invariant after every round, and proves the filter is doing work
  with both an unscoped control (all eight visible) and an unowned scope (zero session
  history but the shared preference visible). Re-run in the repository: 2/2 pass.
- **Capture is per session:** in-flight guard keyed by session id, instance state, cursor
  chunk per session, exclusive cursor (`persisted + 1`) with presence tracking so seq 0 is
  capturable, and a no-op capture writes nothing (F2 pinned by tests; probe of the
  code confirms the write is gated on `events.length > 0 && (!cursorChunk || nextCursor > persisted)`).
- **No cross-session read primitives:** `context_prism_build` rejects a `session` argument
  that differs from the caller's; the Report carries session ids with counts, cursors and
  timestamps only — no chunk content, no query text, no session-scoped ids. That is audit
  metadata, not a read path, and is documented as such.

## 4. Evaluator and docs

- The evaluator can distinguish signal from no signal three ways: the `no-injection`
  control is zero by construction; a hand-built case where the gold chunk is absent but
  the index is non-empty scores Recall 0 with a non-empty ranking; and on the committed
  fixture bm25-only/hybrid score ≈0.976 against the control's 0.000. Routes get their own
  engine and `clearCaches()` per query, with an order-independence test that would catch a
  shared hybrid/bm25 cache.
- `docs/analysis/ROADMAP-REVIEW.md` and `bench/README.md` report the negative result
  plainly (`hybrid` MRR 0.758 < `bm25-only` 0.785, nDCG 0.812 < 0.833) and label
  `no-injection` as zero by construction. I found no passage claiming hybrid wins, and no
  claim about isolation/scoring beyond what the code above does.

## 5. Observations (not defects; no action required for this round)

- `OBS-1` (low): unowned `history`/`trajectory` chunks are visible to every session. That
  is the documented policy for imported corpora, and plugin capture always writes
  `metadata.sessionId` plus `source: session:<id>`, so the plugin path cannot produce one.
  A future writer of session-kind chunks that forgets the owner would become project-wide;
  the predicate is the place to revisit if that happens.
- `OBS-2` (low): the Report exposes per-session chunk counts and cursor values to any
  caller of `context_prism_report`. It is content-free audit metadata, but it is the one
  place where one session can observe another session's *existence* and volume.
- `OBS-3` (informational): `normalizeHitScore` ties two FTS5 near-ties at ~1e-16 (see §2);
  deterministic, sub-ULP, and documented in the code comment.

## Verification run

`npm test` in `/Users/openclaw/Documents/plugins/repo` at `7d01348`:
**113 tests, 113 pass, 0 fail** (exit code 0). The three falsification probes were run on
`/tmp/cp-probe`, a copy of `engine/`, `bench/`, `test/`; the repository was not modified.

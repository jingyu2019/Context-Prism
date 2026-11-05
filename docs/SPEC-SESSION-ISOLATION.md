# ContextPrism v0.9 — Session Isolation & Concurrent Assembly Specification

> **中文摘要**：本文是 v0.9 的唯一契约文档。它定义两件事：(1) 引擎必须**按会话隔离**——
> `history` / `trajectory` 只属于产生它们的会话，`preference` / `code` / `file` 属于整个项目；
> (2) 多个会话可以**并发装配**自己的 prompt context 而互不干扰。文档同时给出每个已知缺陷
> D1…D12（以及实现过程中额外发现的 D13…D16）的精确现状、目标行为与责任任务，给出所有新增/变更
> 公共 API 的签名，按文件把 `engine/` 与 `lib/` 的每个文件**唯一**分配给一个实现任务，并固定
> 评测指标（Recall@K / MRR / nDCG@10 / token efficiency）与三条路由
> （`no-injection` / `bm25-only` / `hybrid`）的定义。

| Field | Value |
| --- | --- |
| Document id | `SPEC-SESSION-ISOLATION` |
| Status | **Normative.** Implementation tasks MUST follow it; deviations require a captain-approved amendment. |
| Release | v0.9.0 (from v0.8.0) |
| Baseline commit | `041581e` — "v0.8.0: make automatic context injection actually work on DSH 0.2.1-rc.5", plus the uncommitted working-tree edits present at specification time |
| Baseline test state | 44/44 green (Node 26) |
| Authored by | `arch` (task `t1`, round 1) |
| Downstream tasks | `t2` scope · `t3` ingest · `t4` eval · `t5` wire · `t6` verify |
| Runtime target | Node ≥ 22.5, tested on Node 26; DSH 0.2.1-rc.5 |

Normative keywords: **MUST**, **MUST NOT**, **SHOULD**, **MAY** (RFC 2119 sense). Every
"current behaviour" claim below was read off the working tree at specification time and is
cited by `file:line` so it can be re-checked; line numbers will drift after edits, the
statements will not.

---

## 1. Problem statement

The engine today has one index per project and one global retrieval space. Session events
captured for session A are written into that shared index with `source: "session:<A>"`, but
**nothing filters them back out at read time**. Any session's assembly can retrieve any other
session's conversation. The plugin also keeps module-level mutable state (`lastProjectRoot`,
engine map keyed without session identity) and the two result caches are keyed without a
session component, so the moment the cache keys start hitting, session B can be served a
window that was assembled for session A.

Two user requirements drive v0.9:

**R-A — session-scoped retrieval.**
A window built for session A contains only session A's `history` / `trajectory` chunks.
`preference` / `code` / `file` chunks stay visible project-wide.

**R-B — concurrent multi-session assembly.**
Several sessions must run prompt-context assembly at the same time without interfering:
each sees only its own history, capture is idempotent under interleaving, and no shared
mutable global decides a session's index path or scope.

Everything else in this release (defect closure, trusted evaluator, ingestion bounds, CJK
tokenization, structured panel) is scaffolding that makes R-A and R-B provable rather than
plausible.

### 1.1 Non-goals (v0.9)

- No upstream PR; this tree is the deliverable.
- No new native dependency, no transformer/vector runtime, no extra provider adapter.
- No change to `package.json` (dependency, script, or version fields). The `test` script is
  frozen; see §8.3 for the v0.9 aggregate gate.
- No per-session **index files**. Isolation is a read-time predicate over one shared index
  per project, not a multi-database design. Rationale: one index per project is what makes
  `code`/`file`/`preference` chunks shared cheaply, and a per-session DB would multiply
  SQLite handles and full-text indexes per session.
- No cross-process coordination protocol. See §9.2 for the documented limitation.

---

## 2. Definitions

| Term | Definition |
| --- | --- |
| **Index** | One `LocalIndex` or `SqliteIndex` per project root (`.lce/index.db` / `.lce/index.json`). Shared by every session in that project. |
| **Scope** | A normalized session identifier (`null` or a non-empty string) supplied per assembly call. `null` means **unscoped** (whole-index, legacy/CLI/tests). |
| **Session-owned chunk** | A `history` or `trajectory` chunk that carries a session owner (§2.1). |
| **Project corpus** | Every chunk that is not session-owned: all `preference` / `code` / `file` chunks, plus any `history` / `trajectory` chunk with no owner (imported JSONL fixtures, seed data — see §2.1). |
| **Assembly** | One call to `buildContext()` / `buildContextAsync()` producing one `ContextWindow`. |
| **Capture** | One call to `captureSessionEvents()`, projecting new host session events into chunks. |
| **Control record** | `SourceKind.SESSION_CURSOR` chunks: capture bookkeeping, never retrieved, never rendered. |

### 2.1 Session ownership rule

Ownership is a pure function of the chunk, defined once in `engine/models.js` and used
everywhere (no second implementation anywhere):

```js
// engine/models.js — normative
export const SESSION_SCOPED_KINDS = Object.freeze([SourceKind.HISTORY, SourceKind.TRAJECTORY]);
export const PROJECT_SCOPED_KINDS = Object.freeze([SourceKind.PREFERENCE, SourceKind.CODE, SourceKind.FILE]);

/**
 * The session that owns this chunk, or null when the chunk belongs to the project.
 * metadata.sessionId is authoritative when present; otherwise the capture-time
 * `session:<id>` source convention decides; anything else is unowned.
 */
export function sessionScopeOf(chunk) {
  const fromMetadata = chunk?.metadata?.sessionId;
  if (typeof fromMetadata === "string" && fromMetadata.trim() !== "") return fromMetadata.trim();
  const fromSource = typeof chunk?.source === "string" ? /^session:(.+)$/.exec(chunk.source) : null;
  return fromSource ? fromSource[1] : null;
}
```

Consequences that MUST hold:

- A chunk captured by `captureSessionEvents` is owned: it is written with
  `source: "session:<id>"` **and** `metadata.sessionId = <id>` (already true today).
- A `history` / `trajectory` chunk ingested from a JSONL file has no owner **unless** the
  record itself carries a non-empty `sessionId` field (the JSONL metadata is copied verbatim
  into `chunk.metadata`). A record that carries `sessionId` is thereby intentionally
  session-private; this is a documented feature, not a leak.
- A chunk whose owner cannot be determined is `null` → project corpus.

---

## 3. Invariants

### 3.1 Isolation invariant (R-A)

**I1 — Kind classification.** Exactly these kinds are session-scoped:

| `SourceKind` | Class | Visible to |
| --- | --- | --- |
| `HISTORY` | session-scoped | the owning session only (or every session when unowned) |
| `TRAJECTORY` | session-scoped | the owning session only (or every session when unowned) |
| `PREFERENCE` | project-scoped | every session of the index |
| `CODE` | project-scoped | every session of the index |
| `FILE` | project-scoped | every session of the index |
| `SESSION_CURSOR` | control | nobody — never retrieved, never rendered |

**I2 — Visibility predicate.** The single rule, implemented once, exported from
`engine/models.js`, and used by every read path:

```js
/**
 * Normative visibility rule. This function is the only definition of "may this
 * chunk appear in this window".
 */
export function isVisibleInScope(chunk, scope) {
  if (!chunk) return false;
  if (chunk.kind === SourceKind.SESSION_CURSOR) return false;   // control record: never visible
  if (scope === null || scope === undefined) return true;       // unscoped: whole project index
  if (!SESSION_SCOPED_KINDS.includes(chunk.kind)) return true;  // project-scoped: always visible
  const owner = sessionScopeOf(chunk);
  return owner === null || owner === scope;                     // foreign session: excluded
}
```

**I3 — Why cross-session leakage is impossible.** For a session-scoped chunk `c` and a scope
`s`, `isVisibleInScope(c, s)` is `true` only when `owner(c) === s` or `owner(c) === null`.
There is no third branch and no fallback. Therefore a chunk owned by session B can enter a
window for session A only if `s === B`, i.e. only if the caller claimed to be B. The
predicate is applied **before scoring**, so ranking, compression, cache reuse and rendering
all operate on an already-filtered candidate set — a foreign chunk is never ranked, never
cached under A's key, and never rendered.

The argument is only as strong as its enforcement points; §3.3 enumerates all of them and
MUST be exhaustive. Any new read path that can reach session-scoped chunks without going
through `isVisibleInScope` is a specification violation.

**I4 — Unscoped is not a leak.** `scope: null` keeps today's semantics (whole index). It is
reserved for CLI/tests/`context_prism_status`-style inspection. The plugin — the only
automatic caller — MUST always pass the real session id (§4.7.1). A future caller that knows
its session and passes `null` is a bug in that caller, not a hole in the predicate.

### 3.2 Concurrency invariant (R-B)

**C1 — Per-call state.** All scope-dependent state travels in the call: `retrievalConfig.scope`
and the `scope` option. No assembly reads per-session state written by a concurrent assembly.

**C2 — N concurrent sessions.** For any N ≥ 2 sessions assembling concurrently against one
shared index, every produced window's `HISTORY` / `TRAJECTORY` items MUST be owned by that
window's scope (or unowned). This MUST hold when the N assemblies are interleaved with
`Promise.all`, including when they share one engine instance and one `TTLCache`.

**C3 — Capture idempotency under interleaving.**
- *Storage:* chunk ids are deterministic (`"<sessionId>:<author>:<seq>"`, already true), so
  re-capturing the same event replaces the row instead of duplicating it. Therefore total
  `HISTORY` + `TRAJECTORY` chunk count equals the number of distinct captureable events,
  under any interleaving, in any order, including a re-run.
- *Cursor:* the persisted capture cursor is **monotone non-decreasing** per session
  (`Math.max(callerCursor, persistedCursor)`), so a stale cursor can never rewind it.
- *Work:* a per-session in-flight guard coalesces a second concurrent capture of the same
  session (§4.3.4). Different sessions NEVER contend: there is no global capture lock.

**C4 — No shared mutable global decides a session's index or scope.**

Permitted module-level state, exhaustively:

| Where | Name | Contents | Session-dependent? |
| --- | --- | --- | --- |
| `lib/index.js` | `engines: Map<"<backend>:<indexPath>", LocalContextEngine>` | index handles only | no — keyed by index path, never by session |
| `lib/index.js` | `sessionState: Map<sessionId, SessionState>` (new, capped) | per-session bookkeeping (§4.7.2) | yes, but keyed and never read by another session |
| `lib/index.js` | `fileScanTimes`, `watchers`, `watchTimers` | per-project filesystem bookkeeping | no |
| `lib/index.js` | `diagnostics` | append-only aggregate counters | no — MUST NOT carry per-session payloads |
| `engine/retrieval.js` | `embeddingCache: Map<chunkId, vector>` | pure memoization | no — chunk ids are globally unique (session-prefixed or content/path-derived) |
| `engine/*` | constructor-instance fields (`retrievalCache`, `compressionCache`, `_captureInFlight`) | per-engine | keyed correctly, see §4.3.2/§4.3.4 |

Forbidden, and removed in v0.9: `lastProjectRoot` (D5). Also forbidden: caching a resolved
project root, index path, or scope in a variable that a *different* call then reads.

A session's index path MUST be a pure function of `(cfg, session.header.cwd, per-call args)`:
`resolveProjectRoot()` returns a value and stores nothing, and `resolveIndex()` composes it with
`cfg.defaultIndex`. Two sessions in two workspaces therefore resolve two different indexes with
no shared variable in between (D5).

`disposeAll()` MUST clear `engines`, `sessionState`, `fileScanTimes`, `watchers`,
`watchTimers`; dropping the engine instances drops `retrievalCache`, `compressionCache` and
`_captureInFlight` with them. No per-session state may survive a plugin reload.

**C5 — Determinism.** Identical `(index revision, scope, query, config, budget)` MUST produce
an identical window, including item order. Ties in every ordering are broken by
`chunk.id.localeCompare(other.chunk.id)` ascending. (JS `Array#sort` is stable, but input
order comes from index scan order, which differs between `LocalIndex` and `SqliteIndex` — an
explicit tie-break is what makes cross-backend results comparable.)

**C6 — What "concurrent" means here.** Node is single-threaded; concurrency is interleaved
async turns. Every capture section is synchronous, so no interleaving can occur *inside* one
capture; the invariants that matter are (a) no `await` between reading the cursor and
committing capture, and (b) the guard, which protects the future async capture and any
re-entrant call. `DatabaseSync` operations are synchronous, so one process cannot interleave
SQLite statements.

### 3.3 Enforcement points (exhaustive)

| # | Point | Requirement |
| --- | --- | --- |
| E1 | `retrieve()` (`engine/retrieval.js`) | filters candidates through `isVisibleInScope` before scoring; this is the choke point |
| E2 | `buildContext` / `buildContextAsync` (`engine/engine.js`) | never call `index.chunksByKind(HISTORY\|TRAJECTORY)`; obtain history/trajectory only via `retrieve()` |
| E3 | `context_prism_build` (`lib/index.js`) | always passes the calling session's id as `scope` (§4.7.1) |
| E4 | prompt-context provider (`lib/index.js`) | always passes `sessionIdOf(session)` as `scope` to `buildContext` / `buildContextAsync` |
| E5 | `context_prism_report` + dashboard (`lib/index.js`) | MUST NOT emit session-scoped chunk **content**; per-session aggregates only |
| E6 | `ContextWindow.report()` (`engine/models.js`) | exposes `scope` so any consumer can audit which scope produced the window |

`chunksByKind()` remains unrestricted by design: it is an index-inspection primitive used for
project-scoped kinds (`PREFERENCE`) and for cursor reads. Any future use of it for
`HISTORY`/`TRAJECTORY` MUST go through `isVisibleInScope`.

---

## 4. API contracts

All signatures are exact. Parameter names, defaults, return field names and ordering are
normative; hidden extra parameters are forbidden. Every new export MUST be additive (no
existing name changes meaning) unless this section says otherwise.

### 4.1 `engine/models.js` (owner: t2)

```js
// Existing, unchanged shape, one new option + one new reported field.
export class ContextWindow {
  constructor({
    query,
    sections = [],
    maxTokens = 0,
    reservedOutputTokens = 0,
    tokenBudget = 0,
    totalTokens = 0,
    omittedCount = 0,
    omittedTokens = 0,
    createdAt = Date.now() / 1000,
    scope = null,               // NEW: normalized scope that produced this window
  } = {}) {}

  scope;                        // NEW instance field: string | null

  get text() {}                 // unchanged
  asMessages(systemPrompt = null) {}   // unchanged

  report() {
    return {
      query, maxTokens, reservedOutputTokens, tokenBudget,
      totalTokens, omittedCount, omittedTokens,
      scope,                    // NEW: string | null
      sections: [ /* unchanged */ ],
    };
  }
}
```

Plus the three new exports from §2.1: `SESSION_SCOPED_KINDS`, `PROJECT_SCOPED_KINDS`,
`sessionScopeOf()`, and `isVisibleInScope()`.

`RETRIEVABLE_KINDS`, `estimateTokens()`, `Chunk`, `ContextSection`, `RetrievedItem`,
`SourceKind` are unchanged.

### 4.2 `engine/retrieval.js` (owner: t2)

```js
export class RetrievalConfig {
  constructor({
    relevanceWeight = 1.0,
    semanticWeight = 0.35,
    recencyWeight = 0.25,
    sourceWeight = 0.2,
    priorityWeight = 0.3,
    recencyHalfLifeDays = 7.0,
    topK = 40,
    sourceWeights = DEFAULT_SOURCE_WEIGHTS,
    useSemantic = true,
    scope = null,              // NEW
  } = {}) {}

  scope;                       // NEW: string | null, normalized by normalizeScope()
}

/**
 * Normalize a scope value. "" and undefined become null; non-strings throw.
 * @param {unknown} scope
 * @returns {string|null}
 * @throws {TypeError} when scope is neither null/undefined nor a string
 */
export function normalizeScope(scope);

/**
 * Score one chunk with the shared hybrid formula. retrieve() uses this too, so
 * preferences are scored by exactly the same arithmetic as everything else.
 *
 * @param {object} input
 * @param {import("./models.js").Chunk} input.chunk
 * @param {number} [input.rawScore=0]   backend relevance, same units as searchWithScores()
 * @param {RetrievalConfig|null} [input.config=null]
 * @param {number|null} [input.now=null]  epoch seconds; one value per assembly for determinism
 * @returns {{score: number, reason: string}}
 */
export function scoreChunk({ chunk, rawScore = 0, config = null, now = null }) ;

/**
 * Unchanged signature; new behaviour: scope filtering + bounded over-fetch.
 * @param {LocalIndex|SqliteIndex} index
 * @param {string} query
 * @param {RetrievalConfig|null} config
 * @returns {import("./models.js").RetrievedItem[]} score desc, tie-break chunk.id asc
 */
export function retrieve(index, query, config = null);
```

Required implementation shape for `retrieve()`:

```js
const cfg = config || new RetrievalConfig();
const candidateK = cfg.scope === null
  ? cfg.topK
  : Math.min(cfg.topK * OVERFETCH_FACTOR, cfg.topK + OVERFETCH_MAX_EXTRA);   // 4 / 200
const hits = index.searchWithScores
  ? index.searchWithScores(query, candidateK)
  : toScoredHits(index.search(query, candidateK));
const visible = hits.filter((hit) => isVisibleInScope(hit.chunk, cfg.scope)).slice(0, cfg.topK);
```

Over-fetch is **mandatory**: without it, a session whose own history never reaches the global
top-K sees an empty history section even though its chunks exist. It is bounded (4× topK, at
most +200 candidates) so the cost is deterministic. `searchWithScores(query, topK)` /
`search(query, topK)` signatures MUST stay as they are (t3 owns those files).

Ranking contract: sort by `score` descending, then `chunk.id` ascending (C5).
`normalizeHitScore()` and `toScoredHits()` keep their current semantics; `FTS_RANK_SCALE`
unchanged.

### 4.3 `engine/engine.js` (owner: t2)

#### 4.3.1 Assembly API

```js
buildContext({
  query,
  maxTokens = 8000,
  reservedOutputTokens = 1024,
  retrievalConfig = null,
  priorityConfig = null,
  includePreferences = true,
  scope = null,                 // NEW
} = {}) -> ContextWindow

async buildContextAsync({
  query,
  maxTokens = 8000,
  reservedOutputTokens = 1024,
  retrievalConfig = null,
  priorityConfig = null,
  includePreferences = true,
  summarizer = null,
  scope = null,                 // NEW
} = {}) -> Promise<ContextWindow>
```

Scope resolution (identical in both methods, one helper):

```js
function resolveScope(explicitScope, retrievalConfig) {
  const a = normalizeScope(explicitScope);
  const b = retrievalConfig ? normalizeScope(retrievalConfig.scope) : null;
  if (a !== null && b !== null && a !== b) {
    throw new TypeError(`conflicting session scope: argument "${a}" vs retrievalConfig "${b}"`);
  }
  return a ?? b;
}
```

- Precedence: explicit option wins; `retrievalConfig.scope` is the fallback. Conflicting
  non-null values throw `TypeError` (silent ambiguity is how leaks get shipped).
- The scope MUST be threaded into the `RetrievalConfig` actually used for retrieval, so
  `retrieve()` is the only place that filters:
  `const cfg = retrievalConfig ? new RetrievalConfig({ ...retrievalConfig, scope }) : new RetrievalConfig({ scope });`
- The resulting `ContextWindow` MUST be constructed with `scope`.
- Both cache keys MUST be computed with the resolved scope (§4.3.2).
- Identical windows for `buildContext` and `buildContextAsync` when `summarizer` is null.

#### 4.3.2 Cache keys (they are strings now)

```js
/** @returns {string} */
_retrievalCacheKey(query, config, scope) {
  return `v1|retrieve|rev:${this.index.revision}|s:${JSON.stringify(scope)}|q:${normalizeQuery(query)}|cfg:${JSON.stringify(fingerprint(config))}`;
}

/** @returns {string} */
_compressionCacheKey(query, budget, items, scope) {
  const sig = createHash("sha1")
    .update(JSON.stringify(items.map((i) => [i.chunk.id, Math.round(i.score * 1e6) / 1e6])))
    .digest("hex");
  return `v1|compress|rev:${this.index.revision}|s:${JSON.stringify(scope)}|q:${normalizeQuery(query)}|b:${budget}|items:${sig}`;
}

import { createHash } from "node:crypto";   // engine.js already imports from node:*

const normalizeQuery = (q) => String(q ?? "").trim().replace(/\s+/g, " ").toLowerCase();

function fingerprint(config) {
  if (!config) return null;
  return [
    config.relevanceWeight,
    config.semanticWeight,
    config.recencyWeight,
    config.sourceWeight,
    config.priorityWeight,
    config.recencyHalfLifeDays,
    config.topK,
    config.useSemantic,
    Object.entries(config.sourceWeights).sort(([a], [b]) => a.localeCompare(b)),
  ];
}
```

Normative properties:

1. **Type: `string`.** The current keys are arrays; `Map`/`TTLCache` compares object keys by
   identity, so today every lookup misses and `cacheSize`/`cacheTtl` are decorative. Making
   the keys strings *activates* the caches — which is precisely why the scope MUST be in the
   key in the same change (D2, D3, D14).
2. **Scope component: `JSON.stringify(scope)`** → `s:null` for unscoped, `s:"sess-1"` for a
   session. Unambiguous; no sentinel that a real id could collide with.
3. **Fingerprint covers every ranking input**: `semanticWeight` and `useSemantic` are in it
   (D15). Without them, `bm25-only` and `hybrid` evaluation routes would share a cache entry
   inside one engine and the A/B comparison would compare a result with itself.
4. **Index revision** stays in the key: any write invalidates.
5. **Compression key keeps the item signature**; the scope is *additional*. The signature
   pins the payload, the scope pins the policy — after a future scoping rule change a stale
   entry can never be reused across scopes.
6. Keys are pure: no clock, no random, no object identity.
7. `clearCaches()` unchanged (clears both caches).

#### 4.3.3 Preference scoring (D6)

Preferences are always included (they are the product promise), but their order MUST depend
on the query:

```js
/**
 * @returns {RetrievedItem[]} every PREFERENCE chunk, score desc, tie-break chunk.id asc
 */
_preferenceItems(query, config, now) {
  const chunks = this.index.chunksByKind(SourceKind.PREFERENCE);        // project-wide, unscoped
  if (chunks.length === 0) return [];
  const raw = new Map(
    (typeof this.index.searchWithScores === "function"
      ? this.index.searchWithScores(query, Math.max(chunks.length, 20))
      : []).map((hit) => [hit.chunk.id, hit.score]),
  );
  const items = chunks.map((chunk) => {
    const { score, reason } = scoreChunk({ chunk, rawScore: raw.get(chunk.id) ?? 0, config, now });
    return new RetrievedItem({ chunk, score, reason: `always-include; ${reason}` });
  });
  items.sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id));
  return items;
}
```

- The `10.0 - i * 0.001` ladder MUST be deleted from both `buildContext` and
  `buildContextAsync`.
- Preferences keep their own always-first section, so "preferences stay ahead of ordinary
  chunks" remains structurally true; the removed ladder was doing nothing for that and was
  masking order irrelevance.
- `now` is computed once per assembly (`Date.now() / 1000`) and passed to both
  `retrieve()`-equivalent scoring and preferences, so two items of the same age score alike.
- No preference is dropped for scoring 0. A chunk whose text has no lexical or semantic
  overlap simply sorts last (deterministic by id).

#### 4.3.4 Capture in-flight guard (D4)

```js
/**
 * Capture one session's model-visible events into the index.
 *
 * Synchronous by contract (baseline callers read the cursor immediately after the call).
 *
 * @param {{session: object, cursor?: number, limit?: number}} options
 * @returns {{
 *   added: number, newUserMessages: number, cursor: number,
 *   total: number, skipped: number,
 *   reentered: boolean,      // NEW: true when this call was coalesced by the in-flight guard
 * }}
 */
captureSessionEvents({ session, cursor = 0, limit = 400 } = {})
```

Normative behaviour:

1. **Guard storage:** `this._captureInFlight = new Map()` created in the constructor
   (instance-level; never module-level, so two engines never contend).
2. **Entry:**
   ```js
   const sessionId = sessionIdOf(session);
   if (!sessionId) return { added: 0, newUserMessages: 0, cursor, total: 0, skipped: 0, reentered: false };
   if (this._captureInFlight.has(sessionId)) {
     return { added: 0, newUserMessages: 0, cursor: this.sessionCursor(sessionId), total: 0, skipped: 0, reentered: true };
   }
   this._captureInFlight.set(sessionId, true);
   try { /* …existing body, with fromSeq below… */ }
   finally { this._captureInFlight.delete(sessionId); }
   ```
   Coalescing returns a **no-op result**, not the other call's result: the in-flight call owns
   the write and the accounting. `added: 0` is honest ("this call inserted nothing"), and the
   caller keeps its diagnostic line truthful.
3. **Authoritative cursor:** `const fromSeq = Math.max(Number(cursor) || 0, this.sessionCursor(sessionId));`
   A stale caller cursor can never cause a rewind or a re-read of already-captured events.
4. **Cursor write is monotone:** write only when `nextCursor > this.sessionCursor(sessionId)`
   (replacing the current `nextCursor !== cursor` condition), one upsert per capture.
5. **Guard is released in `finally`**, so a throw cannot wedge a session forever.
6. **Different sessions never contend**: the map is keyed by session id and holds no global
   lock. `Promise.all` over N sessions proceeds fully in parallel.
7. `sessionCursor(sessionId)` unchanged: reads the `session_cursor` chunk, `0` when absent.

Testability note (for t2/t6): the guard is observable without any async capture by
re-entering from inside a patched `index.addMany`:

```js
const original = engine.index.addMany.bind(engine.index);
engine.index.addMany = (chunks) => { const nested = engine.captureSessionEvents({ session }); assert.equal(nested.reentered, true); return original(chunks); };
```

#### 4.3.5 Ingestion delegation (handoff H1, see §6.3)

`addDirectoryIncremental` keeps its name and gains bounded-walk wiring plus two counters.
`addFileIncremental`'s return object is **frozen** at `{ added, changed, skipped }`
(`test/engine.test.js:126` asserts it with `deepEqual`) — do not add keys there.

```js
addDirectoryIncremental({
  directory, kind = null, extensions = null, ignore = [], statePath = null,
  maxFileBytes = null,             // NEW, forwarded to ingest.js (null = ingest default 1 MiB)
} = {}) -> {
  added: number, changed: number, skipped: number,
  sizeSkipped: number, symlinkSkipped: number,   // NEW
}
```

Body: load state → `const { chunks, state: next, stats } = ingestDirectoryIncremental({ directory, state, kind, extensions, ignore, maxFileBytes })`
→ `if (chunks.length) this.addChunks(chunks)` → `this._saveState(stateFile, next)` → return the
merged object above. `added` stays "number of chunks added" (existing consumers read only
`result.added`).

`next` is the **complete** next state: exactly one entry per file the walk actually visited in
this run. The caller persists it verbatim and MUST NOT merge, prune, or `existsSync` around it —
pruning entries for deleted files is the walk's job, because only the walk knows what is still
present. (This replaces today's `currentKeys` + `existsSync` pruning loop in `engine.js`; the
observable behaviour — deleted files drop out of the state — is preserved.)

### 4.4 `engine/ingest.js` (owner: t3)

```js
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;   // 1 MiB
export const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 20000;
export const DEFAULT_IGNORE_FILE = ".lceignore";

/**
 * Bounded, symlink-safe, ignore-file-aware directory walk. Synchronous.
 *
 * @returns {{
 *   files: Array<{path: string, size: number, mtimeMs: number}>,
 *   stats: {sizeSkipped: number, symlinkSkipped: number, ignored: number,
 *           walkErrors: number, truncated: boolean},
 * }}
 */
export function walkFiles(directory, {
  extensions = null,          // Set<string>|string[]|null -> DEFAULT_EXTENSIONS
  ignore = [],                // built-in name list, matched per path segment (current semantics)
  ignoreFile = DEFAULT_IGNORE_FILE,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  followSymlinks = false,     // MUST default false
} = {}) -> { files, stats }

/**
 * Incremental directory ingest: mtime+size diffing + the bounded walk + chunk building.
 * Synchronous. Returns chunks and the next state map; the caller owns persistence.
 *
 * @returns {{
 *   chunks: Chunk[],
 *   state: Record<string, {mtime: number, size: number}>,
 *   stats: {added: number, changed: number, skipped: number,
 *           sizeSkipped: number, symlinkSkipped: number, ignored: number,
 *           walkErrors: number, truncated: boolean},
 * }}
 * Note: `state` is the complete next state (only files present in this walk).
 */
export function ingestDirectoryIncremental({
  directory, state = {}, kind = null, extensions = null, ignore = [], maxFileBytes = null,
} = {}) -> { chunks, state, stats }
```

Rules:

- **Symlinks MUST NOT be followed**, including symlinked directories (loops are structurally
  impossible then). Every skipped symlink increments `symlinkSkipped`. If `followSymlinks` is
  ever set true, the walk MUST track resolved `realpath` values in a `Set` and refuse to
  re-enter a directory already visited; the loop test stays green either way.
- **`.lceignore`** at the walked root, one pattern per line, `#` comments and blank lines
  skipped, patterns matched against the path relative to the root with `path.matchesGlob`
  (Node ≥ 22.5); when unavailable, fall back to exact basename / prefix matching. Ignored
  entries increment `ignored`. An `ignore` option still applies on top (existing semantics).
- **Bounds:** a file larger than `maxFileBytes` is not read (`sizeSkipped`); the walk stops
  and sets `truncated: true` after `maxTotalBytes` of file content or `maxFiles` visited
  files. The walk is synchronous, so "concurrency" is 1 by construction — the caps are what
  bound one tick's work; this is the documented meaning of "bounded" for a sync API.
- **Frozen:** `chunkText`, `ingestText`, `ingestFile`, `ingestDirectory`, `ingestHistoryJsonl`,
  `ingestTrajectoryJsonl`, `kindForPath`, `relativePath` keep their names, arity, **synchronous
  nature and return types** (`Chunk[]` / `Chunk` / `string`). `ingestDirectory` accepts the new
  options (`maxFileBytes`, `maxTotalBytes`, `maxFiles`, `ignoreFile`) and still returns
  `Chunk[]`; its skip counts are not returned there (no consumer needs them) — the incremental
  API is where bounds are reported.

### 4.5 Index diagnostics (owner: t3)

Both index classes expose one uniform, read-only snapshot so `context_prism_report` can surface
D10 without knowing which backend is in play:

```js
// engine/sqlite_index.js and engine/index.js — same shape on both
get diagnostics() {
  return {
    ftsErrorCount: 0,             // FTS5 MATCH threw (syntax/module unavailable)
    likeFallbackCount: 0,         // times the capped LIKE scan ran
    likeFallbackRows: 0,          // rows the capped scan returned (<= cap)
    lastFallbackAt: null,         // epoch ms | null
    searchTextMigration: "ok",    // "ok" | "failed" | "skipped" (§4.6.1); always "ok" on LocalIndex
  };
}
```

`LocalIndex` has no FTS path; it returns the same shape with zeroes/nulls (a uniform read
contract beats a conditional in the consumer).

SQLite fallback rule (D10):

- FTS5 availability is detected **once** (first `MATCH`, or at open) and cached in a
  `_ftsAvailable` flag. `search()` / `searchWithScores()` MUST NOT fall back to `LIKE` because
  a MATCH returned zero rows — the current `if (rows.length > 0) return …` fall-through makes
  **every zero-hit query** scan the whole `chunks` table.
- On a MATCH error: increment `ftsErrorCount`, re-build the query from sanitized tokens once,
  and retry MATCH once. Only if FTS5 is genuinely unavailable does the LIKE path run.
- The LIKE path scans at most the newest `LIKE_SCAN_ROW_CAP` rows (default `5000`) via a
  rowid-bounded subquery, returns at most `min(topK, 50)` rows, and increments
  `likeFallbackCount` / `likeFallbackRows` / `lastFallbackAt`.
- `_buildFtsQuery()` keeps quoting every token; after the CJK bigram change (§4.6) tokens are
  `[a-z0-9_]+` and CJK bigrams only, so quoted input is always valid FTS5 syntax.

### 4.6 `engine/text_utils.js` (owner: t3)

```js
/**
 * Tokenize for BM25, embeddings and extractive overlap.
 * - ASCII: /[A-Za-z0-9_]+/ lowercased (unchanged)
 * - CJK ([U+4E00–U+9FFF]): each maximal run of length L emits overlapping bigrams
 *   `run[i..i+1]` for i in 0..L-2; L === 1 emits the single character
 * - Token order follows the text's left-to-right order (ASCII and CJK interleaved)
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text);
```

Consequences that MUST be true: a 4-character Chinese query matches a 20-character Chinese
sentence containing it (shared bigrams); `estimateTokens("你好世界") === 4` still holds
(`estimateTokens` is untouched, it counts characters, not tokens); ASCII tokenization is
byte-for-byte unchanged. `splitSentences`, `termFrequencies`, `cosineSimilarity` unchanged.

#### 4.6.1 SQLite mirror — mandatory companion change (measured, not assumed)

`tokenize()` alone would **regress** CJK search on the default backend. FTS5's `unicode61`
tokenizer indexes a whole CJK run as one token, and it tokenizes the *stored column*, not our
query. Measured on Node 26 / `node:sqlite` at specification time:

```
sentence = "我们今天讨论的是上下文窗口的隔离设计和并发装配的问题"   (24 chars)
query    = "上下文窗"                                              (4 chars)

fts over content,   MATCH '"上下文窗"'                 -> 0 hits
fts over content,   MATCH '"<whole sentence>"'         -> 1 hit    (whole-run token only)
fts over content,   MATCH '"上下" OR "下文" OR "文窗"'   -> 0 hits
fts over tokens,    MATCH '"上下" OR "下文" OR "文窗"'   -> 1 hit    (shadow column works)
```

So after the bigram change a CJK query becomes a bigram OR-list that can never match a
whole-run FTS token: SQLite would return **zero** CJK hits where it used to return exact-run
hits. Required, in `engine/sqlite_index.js`:

```sql
-- chunks gains one shadow column
ALTER TABLE chunks ADD COLUMN search_text TEXT;

-- the FTS table indexes tokenized text, not raw content
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  search_text, content='chunks', content_rowid='rowid', tokenize='unicode61'
);
-- the three triggers mirror search_text (INSERT: new.search_text; DELETE: old.search_text)
```

Write rule in `_add()` — ASCII-only rows are stored verbatim so ASCII behaviour is unchanged
and only CJK rows pay the ~2× expansion:

```js
const searchText = /[\u4e00-\u9fff]/.test(chunk.content) ? tokenize(chunk.content).join(" ") : chunk.content;
```

Migration on open (idempotent, one pass, recorded in the existing `meta` table):

1. If `PRAGMA table_info(chunks)` lacks `search_text` → `ALTER TABLE chunks ADD COLUMN search_text TEXT`.
2. Backfill rows with `search_text IS NULL` in batches of ~500 (JS computes the value).
3. Drop and recreate `chunks_fts` and its three triggers over `search_text`, then
   `INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')`. Only the FTS shadow is rebuilt;
   `chunks` rows are never dropped, so no captured history is lost.
4. `INSERT INTO meta(key, value) VALUES('search_text_version','1') ON CONFLICT(key) DO UPDATE …`;
   skip steps 1–3 when the key is already `1`.

If the migration cannot run (read-only DB, locked file), it MUST NOT be silent: catch, log, set
`diagnostics.searchTextMigration = "failed"` on the index, and continue on the content-based FTS
(documented degraded mode). The flag is surfaced through `index.diagnostics` (§4.5) so
`context_prism_report` shows it.

`_buildFtsQuery()` is unchanged (quote every token, join with `OR`): with bigrams it becomes a
recall-oriented OR of bigrams and rank does the ordering — the same shape as today's
multi-token ASCII behaviour.

### 4.7 `lib/index.js` (owner: t5)

#### 4.7.1 Session scope at every call site

```js
const scope = sessionIdOf(context?.agent?.session);      // prompt-context provider
const window = engine.buildContext({ ..., scope });
const capture = engine.captureSessionEvents({ session, cursor: engine.sessionCursor(sessionId), limit: cfg.sessionCaptureLimit });
```

`context_prism_build` MUST resolve its scope from the caller, never from a module variable:

```js
// parameters gain: session?: string
const callingScope = sessionIdOf(exec?.agent?.session);
const requestedScope = typeof toolArgs.session === "string" && toolArgs.session.trim() !== "" ? toolArgs.session.trim() : null;
if (callingScope && requestedScope && callingScope !== requestedScope) {
  throw new Error(`context_prism_build cannot read another session: caller is "${callingScope}", requested "${requestedScope}"`);
}
const scope = callingScope ?? requestedScope;   // null when neither is known
```

The explicit `session` parameter exists for non-session callers (batch/CLI/tests). It is not a
cross-session read primitive and MUST NOT be usable as one.

#### 4.7.2 Engine and per-session state (D8)

```js
const engines = new Map();      // key: `${backend}:${indexPath}` — index handles ONLY
const sessionState = new Map(); // key: sessionId — bookkeeping ONLY
const SESSION_STATE_MAX = 512;

function getEngine(cfg, index, backend) { /* unchanged: one engine per index */ }
```

Rules:

- `getEngine`'s signature and key stay exactly as they are. A session id MUST NOT enter the
  key: it would multiply SQLite handles and indexes per session and destroy the shared
  project corpus that R-A explicitly wants.
- Session identity travels as a call argument (the `scope` option), never through the engine
  map. That is the whole fix for D8: the engine is an *index* handle, not a session handle.
- `sessionState` entries are `{ lastInjectedAt: number, lastWindowTokens: number, lastSections: string[] }`;
  only the owning session's entry may be read or written; the map is capped
  (`SESSION_STATE_MAX`, evict oldest insertion first) and cleared by `disposeAll()`.

#### 4.7.3 Project resolution and routes (D5, D12)

`lastProjectRoot` is deleted. `resolveProjectRoot(cfg, exec, ctx)` becomes **pure**: it derives
the root from `exec.agent.session.header.cwd`, optionally refined by
`ctx.workspaceRegistry.resolveByPath(cwd)`, and returns it without storing anything.

The HTTP routes resolve their project explicitly, per request:

```
GET /context-prism/report?project=<absolute-path>
GET /context-prism/dashboard?project=<absolute-path>
```

```js
function resolveRouteProject(cfg, req) -> { root: string, source: "query" | "config" | "cwd" }
```

Precedence, in order:

1. `project` query parameter: MUST be absolute and MUST resolve (`statSync().isDirectory()`),
   else respond `400` with `{ "error": { "code": "BAD_PROJECT", "message": "…" } }`.
2. `cfg.defaultProjectRoot` (new optional config string, absolute) when configured.
3. `process.cwd()` — deterministic for a given process, independent of call order.

`source` is reported back so a caller can see which rule applied. No request may observe a
project chosen by a *different* request. New config field: `defaultProjectRoot: z.string().default("")`
(empty = unset).

`GET /context-prism/report` → `Content-Type: application/json; charset=utf-8`, body = the
Report object (§4.7.4). It MUST NOT emit HTML, and errors are JSON.
`GET /context-prism/dashboard` MAY remain an HTML page for human use, but it MUST be rendered
from the same Report object (`renderDashboardHtml(report)`); the host MUST NOT contain a second
independent data path.

#### 4.7.4 New tool: `context_prism_report`

```
name: context_prism_report
description: Structured ContextPrism state for the current project: chunk counts by kind and
             scope, per-session capture status, injection counters, host compatibility and
             index diagnostics. Returns JSON; renders no HTML.
parameters: {
  project?:      string,                        // absolute path; same precedence as routes
  index?:        string,                        // relative to project
  backend?:      "auto" | "json" | "sqlite",
}
output.schema: {
  type: "object", additionalProperties: false,
  properties: {
    output: { type: "string", required: true },
    report: { type: "object", required: true, additionalProperties: true },
  },
  // render: (_args, value) => [{ type: "text", text: value.output }]
}
returns: { output: string, report: Report }
```

`Report` — exact shape, `schemaVersion: 1`:

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": 1762345678901,                     // epoch ms
  "project": { "root": "/abs/project", "source": "query" },   // query | config | cwd
  "index": {
    "path": "/abs/project/.lce/index.db",
    "backend": "sqlite",                            // sqlite | json
    "revision": 42,
    "chunks": 1234
  },
  "counts": {
    "total": 1234,
    "byKind": {                                     // ALL six kinds, zero-filled
      "preference": 3, "history": 900, "trajectory": 300,
      "code": 20, "file": 10, "session_cursor": 1
    },
    "byScope": { "sessionScoped": 1200, "projectScoped": 33, "unowned": 1 }
  },
  "sessions": [                                     // sorted by sessionId asc
    { "sessionId": "abc", "history": 12, "trajectory": 5,
      "cursor": 17, "lastChunkAt": 1762345600 }     // lastChunkAt: epoch seconds | null
  ],
  "injection": {
    "mode": "prompt-context",                       // prompt-context | pre-step-fallback | off
    "injections": 9, "skippedEmpty": 1, "reentries": 0,
    "last": { "at": 1762345600000, "tokens": 1832, "sections": ["Relevant History"] } , // | null
    "lastError": null                               // { at, message, time } | null
  },
  "host": { "version": "0.2.1-rc.5", "target": "0.2.1-rc.5",
            "supported": true, "reason": "…" },
  "diagnostics": {
    "search": { "ftsErrorCount": 0, "likeFallbackCount": 0,
                "likeFallbackRows": 0, "lastFallbackAt": null }
  }
}
```

Hard constraints (E5):

- No chunk `content`, no query text, no chunk ids of session-scoped chunks. Session rows carry
  **counts only** — a report is an audit view, not a cross-session read channel.
- Every field above is always present (`null` where empty); `byKind` always has all six keys.
- The `counts.byScope` split uses `sessionScopeOf()` / `SESSION_SCOPED_KINDS` from
  `engine/models.js` — no second copy of the rule.
- `sum(byKind) === total`; `sessionScoped + projectScoped === total`.

`context_prism_status` MAY keep its current human-readable output; it SHOULD be backed by the
same `buildReport()` object so the two can never disagree.

#### 4.7.5 `context_prism_evaluate` (D7)

```
parameters: { project?: string, queries?: string, index?: string, backend?: "auto"|"json"|"sqlite",
              k?: number, routes?: string }
returns: { output: string, report: EvaluationReport & { total: number } }
```

- `queries` (JSON array) MAY override the fixture set; it MUST be validated (each item needs a
  non-empty `query` and a `goldChunkIds` array). Missing/invalid → throw a message naming the
  first offending index.
- The tool delegates to `evaluateRetrieval()` (§4.8) and reports the three routes
  `no-injection`, `bm25-only`, `hybrid` side by side. Substring hit detection and the three
  hardcoded queries MUST be deleted.
- `report.total === report.queryCount` is kept as a compatibility alias (one existing consumer
  reads `report.total` and `output.includes("hit rate")`); the text output keeps a line per
  route containing `hit rate`.

### 4.8 `engine/evaluation.js` (owner: t4, new file)

```js
export const ROUTES = Object.freeze(["no-injection", "bm25-only", "hybrid"]);

/**
 * @typedef {{query: string, goldChunkIds: string[], sessionId?: string|null, id?: string}} BenchmarkQuery
 */

/**
 * Run the benchmark across routes.
 *
 * @param {object} options
 * @param {import("./index.js").LocalIndex|import("./sqlite_index.js").SqliteIndex} options.index  required, read-only
 * @param {BenchmarkQuery[]} options.queries                                                      required, non-empty
 * @param {string[]} [options.routes=ROUTES]        subset of ROUTES, order preserved
 * @param {number} [options.k=10]                   cutoff for Recall@K / MRR / nDCG
 * @param {number} [options.nDCGAt=10]              always reported as ndcgAt10
 * @param {number} [options.maxTokens=4000]         assembly budget per query
 * @param {number} [options.reservedOutputTokens=800]
 * @param {import("./retrieval.js").RetrievalConfig|null} [options.retrievalConfig=null]
 * @param {import("./prioritization.js").PriorityConfig|null} [options.priorityConfig=null]
 * @returns {Promise<EvaluationReport>}
 */
export async function evaluateRetrieval({ index, queries, routes = ROUTES, k = 10, nDCGAt = 10,
  maxTokens = 4000, reservedOutputTokens = 800, retrievalConfig = null, priorityConfig = null } = {});

/**
 * Load the committed fixture: bench/corpus/** chunked with stable ids + bench/queries.jsonl.
 * @param {{dir?: string}} [options]  default { dir: "bench" }
 * @returns {{chunks: import("./models.js").Chunk[], queries: BenchmarkQuery[]}}
 */
export function loadBenchFixture({ dir = "bench" } = {});

export function recallAtK(rankedIds, goldIds, k);     // -> number in [0,1]
export function reciprocalRank(rankedIds, goldIds, k); // -> number in [0,1]
export function ndcgAtK(rankedIds, goldIds, k);        // -> number in [0,1]
export function tokenEfficiency(injectedTokens, hitTokens); // -> number|null
```

```ts
type EvaluationReport = {
  schemaVersion: 1;
  k: number;
  nDCGAt: number;
  routes: string[];              // exactly ["no-injection","bm25-only","hybrid"] by default order
  queryCount: number;
  corpusSize: number;
  elapsedMs: number;
  byRoute: Record<string, RouteMetrics>;
  perQuery: QueryResult[];
};

type RouteMetrics = {
  route: "no-injection" | "bm25-only" | "hybrid";
  recallAtK: number;    // macro average over queries
  mrr: number;          // macro average, truncated at k
  ndcgAt10: number;     // macro average
  tokenEfficiency: number | null;   // macro average of per-query values; null when all null
  injectedTokens: number;           // sum over queries
  hitTokens: number;                // sum over queries
  hitRate: number;                  // fraction of queries with >= 1 hit in the top k
};

type QueryResult = {
  id: string | null;
  query: string;
  goldChunkIds: string[];
  sessionId: string | null;
  byRoute: Record<string, {
    rankedIds: string[];      // truncated to k
    hitIds: string[];         // gold ids present in rankedIds
    firstHitRank: number | null;
    recallAtK: number;
    mrr: number;
    ndcgAt10: number;
    injectedTokens: number;
    hitTokens: number;
    tokenEfficiency: number | null;
  }>;
};
```

Implementation constraints:

- **Read-only**: no index writes, no cache pollution across queries, no network, no LLM. Route
  assembly uses `new LocalContextEngine({ index })` + `buildContext` with a direct
  `RetrievalConfig` (no summarizer). Constructing an engine around an existing index MUST NOT
  open a second database.
- **Deterministic**: same input → same report, including ordering (C5 tie-break).
- **Route isolation**: each route MUST use its own `RetrievalConfig` **and** its own engine
  instance (or a `clearCaches()` between routes), so `bm25-only` can never be served a
  `hybrid`-cached ranking (D15). Assert this in a test.

### 4.9 `lib/client.js` (owner: t5)

- The sidebar action MUST NOT `window.open` a separate document. It renders the structured
  report in-place (drawer/overlay inside the DSH shell, or a host panel slot if one exists)
  and fetches `GET /context-prism/report?project=<encodeURIComponent(root)>`.
- Only `react` may be required (the single declared seed in `package.json`). No new
  `require(...)` of undeclared packages — that throws at materialization.
- No `dangerouslySetInnerHTML`; no host-produced HTML inside the panel.
- Failure paths are visible: a non-2xx or thrown fetch renders an error line containing the
  status, not an empty panel.
- All side effects stay inside the factory closure (existing contract, unchanged).

---

## 5. Defect table

Severity: **P0** = breaks R-A/R-B or produces wrong results; **P1** = correctness/observability
gap that undermines a v0.9 claim; **P2** = latent/hygiene. `Owner` is the implementation task
that closes it; where a defect spans two files under two owners (D7, D11), the **primary owner
is listed first** and the mechanics are pinned in §6.3 (handoffs). Every defect has at most one
primary owner, so nothing is double-worked or dropped.

### 5.1 D1–D12 (required)

| ID | Sev | File(s) | Current behaviour (verified at baseline) | Required behaviour | Owner |
| --- | --- | --- | --- | --- | --- |
| **D1** | P0 | `engine/retrieval.js` | `retrieve()` calls `index.searchWithScores(query, topK)` over the whole index and scores every hit; no kind or session filter exists, so any session's captured `history` / `trajectory` is retrievable by every session. (`retrieval.js:40-70`) | Filter every candidate through `isVisibleInScope(chunk, cfg.scope)` **before** scoring, with the bounded over-fetch of §4.2. `HISTORY`/`TRAJECTORY` of a foreign session never enter the ranked list; `PREFERENCE`/`CODE`/`FILE` stay project-wide; `SESSION_CURSOR` never appears. | t2 |
| **D2** | P0 | `engine/engine.js` | `_retrievalCacheKey` returns `["retrieve", revision, query, fingerprint]` — no scope. Because the key is an **array**, `Map` compares it by identity, so every lookup currently misses and the cache never serves anything; the omission becomes an active cross-session leak the moment the key is normalized. (`engine.js:381-383`) | Key is a `string` (§4.3.2) containing `rev`, `JSON.stringify(scope)`, the normalized query and the full config fingerprint. Scope in the key is mandatory in the same change that makes the key a string. | t2 |
| **D3** | P0 | `engine/engine.js` | `_compressionCacheKey` returns `["compress", revision, query, budget, itemSig]` — no scope, same array-key defect, so a compressed section (including preference sections) can be replayed across sessions once the key is normalized. (`engine.js:398-401`) | Same treatment: string key, `s:${JSON.stringify(scope)}` component **in addition to** the item signature. | t2 |
| **D4** | P0 | `engine/engine.js` | `captureSessionEvents` has no re-entry guard. Two assemblies for one session both call it with their own cursor; storage happens to stay consistent (deterministic ids + upsert) but work is duplicated, `added` is double-counted, and the cursor is written twice. There is no protection if capture ever grows an `await`. (`engine.js:146-182`) | Per-session in-flight guard (§4.3.4): coalesced call returns `reentered: true` with `added: 0`; authoritative cursor is `max(caller, persisted)`; cursor writes are monotone and single; different sessions never contend; guard released in `finally`. Signature stays synchronous, gains `reentered`. | t2 |
| **D5** | P0 | `lib/index.js` | `let lastProjectRoot = null` is set by every `resolveProjectRoot()` call and read by the dashboard route, so the project a request renders is whichever session last ran a tool — multi-workspace concurrency renders the wrong project. (`lib/index.js:71, 773, 479`) | Delete the global. `resolveProjectRoot()` becomes pure. Routes resolve per request: `?project=` → `cfg.defaultProjectRoot` → `process.cwd()`, reporting `source` (§4.7.3). One host serves two project roots correctly in a test. | t5 |
| **D6** | P1 | `engine/engine.js` | Preference items are scored `10.0 - i * 0.001` (storage order), ignoring the query entirely, in both `buildContext` and `buildContextAsync`. (`engine.js:250, 327`) | Preferences are still always included, but ordered by the shared hybrid score via `scoreChunk()` with `rawScore` from `index.searchWithScores`; deterministic tie-break by chunk id (§4.3.3). Two queries over a corpus with differing relevance produce different preference order. | t2 |
| **D7** | P0 | `lib/index.js`, `engine/evaluation.js` | `context_prism_evaluate` decides a hit with `JSON.stringify(entry.chunk).toLowerCase().includes(expected)` and ships three hardcoded queries; the "A/B" result is therefore meaningless. (`lib/index.js:361-437`) | Delete substring detection and the hardcoded set. Delegate to `evaluateRetrieval()`; report the three routes `no-injection`, `bm25-only`, `hybrid` with Recall@K / MRR / nDCG@10 / token efficiency (§7). Keep `report.total` and a `hit rate` text line for compatibility. | t5 (tool) / t4 (harness) |
| **D8** | P1 | `lib/index.js` | `getEngine` keys engines by `` `${backend}:${index}` `` only, so there is nowhere safe to attach per-session state; any attempt today would leak it across sessions that share the index. (`lib/index.js:782-795`) | Engine map stays keyed by index (an engine is an index handle). Session identity MUST NOT enter that key; it travels as the `scope` call option. Any per-session bookkeeping lives in the capped `sessionState` map keyed by session id and cleared by `disposeAll()` (§4.7.2). | t5 |
| **D9** | P1 | `engine/text_utils.js`, `engine/sqlite_index.js` | `TOKEN_RE = /[a-zA-Z0-9_]+\|[\u4e00-\u9fff]+/g` returns a whole CJK run as one token, so a short Chinese query can only match an identically-sized run — a substring never matches a longer sentence. (`text_utils.js:3-7`) Additionally FTS5's `unicode61` indexes a CJK run as **one** token and tokenizes the stored column, so bigram queries alone score **0** CJK FTS hits (measured, §4.6.1). | CJK runs are split into overlapping bigrams (single char for L=1) in text order; ASCII unchanged (§4.6), **and** `sqlite_index` indexes a `search_text` shadow column fed by `tokenize()` so both backends answer the same bigram query (§4.6.1, migration included). A 4-char query matches a 20-char sentence on **both** `LocalIndex` and `SqliteIndex`; `estimateTokens` untouched. | t3 |
| **D10** | P1 | `engine/sqlite_index.js` | Two failure modes collapse into one silent branch: a MATCH that returns zero rows (`rows.length > 0` is false) and a MATCH that throws both fall through to `content LIKE '%query%'`, a full-table scan. No cap, no counter, no diagnostic — the common "no match" query pays a full scan. (`sqlite_index.js:142-146, 164-172`) | FTS5 availability detected once and cached; zero-row MATCH returns `[]` (no fallback); one sanitized retry on error; LIKE only when FTS5 is genuinely unavailable, scanning at most the newest 5000 rows and returning at most `min(topK, 50)`; counters exposed via `index.diagnostics` (§4.5). | t3 |
| **D11** | P1 | `engine/ingest.js`, `engine/engine.js` | `ingestDirectory` reads every matching file synchronously with no size cap, no total-volume cap, no `.lceignore`; symlinks are skipped only implicitly (`Dirent.isDirectory()` is false for a link), so the behaviour is safe-by-accident, untested and uncounted, and there is no realpath loop protection for any future follow mode. (`ingest.js:55-69, 147-156`; `engine.js:87-133`) | `walkFiles()` + `ingestDirectoryIncremental()` with `maxFileBytes` (1 MiB), `maxTotalBytes` (32 MiB), `maxFiles` (20000), `.lceignore` support, explicit symlink skip with counters, realpath loop protection behind `followSymlinks`, and a symlink-loop test proving termination (§4.4). `addDirectoryIncremental` reports `sizeSkipped`/`symlinkSkipped` (§4.3.5, handoff H1). | t3 |
| **D12** | P1 | `lib/client.js`, `lib/index.js` | The sidebar action calls `window.open("/context-prism/dashboard")` — a separate browser tab — and the host's only data path is `buildDashboardHtml()`, i.e. the host generates HTML instead of returning structured data. (`client.js:29-31`; `lib/index.js:817-855`) | New `context_prism_report` tool and `GET /context-prism/report` return the structured `Report` (§4.7.4); the client renders that report in-place (no `window.open`, no `dangerouslySetInnerHTML`); the legacy HTML dashboard, if kept, is rendered from the same Report object. | t5 |

### 5.2 D13–D16 (additional, found while writing this spec)

| ID | Sev | File(s) | Current behaviour | Required behaviour | Owner | Blocking? |
| --- | --- | --- | --- | --- | --- | --- |
| **D13** | P1 | `engine/retrieval.js` | `retrieve()` never consults `RETRIEVABLE_KINDS`; `session_cursor` chunks are only kept out of windows by the accident that their content is a bare sequence number that rarely matches a query. (`retrieval.js:40-70`) | `isVisibleInScope()` returns `false` for `SESSION_CURSOR` unconditionally (already in §2's predicate), so the exclusion is structural. | t2 | yes — folded into D1's fix, no extra work |
| **D14** | P0 | `engine/engine.js`, `engine/cache.js` | Both cache keys are arrays; `TTLCache` is a `Map`, so keys are compared by identity and every lookup misses. `cacheSize` / `cacheTtl` are decorative and the caches have never served an entry. | String keys (§4.3.2). No change to `TTLCache` itself. A test must observe a second call returning the *same* cached item ids for the same key, and different ids for a different scope. | t2 | yes — it is the precondition for D2/D3 being meaningful |
| **D15** | P0 | `engine/engine.js` | `_retrievalConfigFingerprint` omits `semanticWeight` and `useSemantic`, so two configs that rank differently can share a cache entry. Latent today (D14), a real correctness bug the moment keys are strings — and it would corrupt the `bm25-only` vs `hybrid` comparison. | Fingerprint includes `semanticWeight` and `useSemantic` in the fixed order of §4.3.2. | t2 | yes — required for t4/t5 route isolation |
| **D16** | P2 | `engine/retrieval.js` | `embeddingCache` is a module-level `Map` keyed by chunk id with no eviction; it grows for the process lifetime. Ids are unique per chunk, so it never leaks across sessions. | Out of scope for v0.9 (documented in §9.1). If t2 touches it incidentally, a simple size cap (e.g. 10 000 entries, insertion-order eviction) is acceptable. | t2 | no |

---

## 6. File ownership

One file, one owner. "edit" = may change; "hold" = MUST NOT change in v0.9 (the owner is
accountable for its invariants; if a change becomes necessary, escalate to the captain for an
amendment rather than editing it).

### 6.1 `engine/`

| File | Owner | Mode | Why / what |
| --- | --- | --- | --- |
| `engine/models.js` | t2 | edit | scope constants, `sessionScopeOf`, `isVisibleInScope`, `ContextWindow.scope` + `report().scope` |
| `engine/retrieval.js` | t2 | edit | `RetrievalConfig.scope`, `normalizeScope`, `scoreChunk`, scoped `retrieve()` with over-fetch |
| `engine/engine.js` | t2 | edit | scope threading, string cache keys, preference scoring, capture guard, `addDirectoryIncremental` delegation (H1) |
| `engine/cache.js` | t2 | hold | `TTLCache` semantics are the reason keys must be strings; no change needed |
| `engine/compression.js` | t2 | hold | `compressItems` / `compressItemsAsync` / `PACKING_SEPARATOR_TOKENS` are consumed by the cache-key contract |
| `engine/prioritization.js` | t2 | hold | `prioritize()` runs after scoped retrieval; must not re-introduce unfiltered items |
| `engine/embedding.js` | t2 | hold | `scoreChunk` reuses `cosineSimilarity`/`embedText` |
| `engine/session_events.js` | t2 | hold | `sessionIdOf`/`describeEvent` define the ownership inputs; shape must not drift |
| `engine/ingest.js` | t3 | edit | bounded walk, `.lceignore`, symlink policy, `ingestDirectoryIncremental` |
| `engine/index.js` | t3 | edit | `diagnostics` getter; BM25 stats after CJK bigrams |
| `engine/sqlite_index.js` | t3 | edit | FTS availability flag, capped observable LIKE fallback, `diagnostics` |
| `engine/text_utils.js` | t3 | edit | CJK bigram `tokenize()` |
| `engine/evaluation.js` | t4 | **create** | `evaluateRetrieval`, metric helpers, `loadBenchFixture`, `ROUTES` |
| `engine/providers.js` | t5 | hold | documented as "stand-alone convenience, not used in-host" |
| `engine/summarizer.js` | t5 | hold | `summarizer` option is injected through `buildContextAsync`; keep the callback contract |
| `engine/version.js` | t5 | hold | `host` block of the Report comes from here |

Coverage check: 16 files, 16 assignments, each exactly once —
t2: 8 (`models`, `retrieval`, `engine`, `cache`, `compression`, `prioritization`, `embedding`, `session_events`);
t3: 4 (`ingest`, `index`, `sqlite_index`, `text_utils`);
t4: 1 (`evaluation`);
t5: 3 (`providers`, `summarizer`, `version`).

### 6.2 `lib/`

| File | Owner | Mode | Why / what |
| --- | --- | --- | --- |
| `lib/index.js` | t5 | edit | scope at every call site, pure project resolution, Report tool + JSON route, evaluate delegation, `disposeAll` clears `sessionState` |
| `lib/client.js` | t5 | edit | structured panel, no `window.open`, no HTML injection |

### 6.3 Cross-file handoffs

These are the only places where one task's deliverable is consumed by another's file. Each is
one-directional and small; the consumer must not invent an alternative interface.

| # | Producer | Consumer | Contract |
| --- | --- | --- | --- |
| **H1** | t3 `ingest.js`: `walkFiles()`, `ingestDirectoryIncremental()` | t2 `engine.js`: `addDirectoryIncremental()` | Exactly §4.3.5. t2 adds the delegation + two returned counters; t3 owns all walk logic. **t3 is not blocked on H1**: its own acceptance is testable directly against `ingestDirectoryIncremental` in `test/ingest.test.js`. **t2 is not blocked on H1 either**: if the import is not there yet, t2 may keep the current inline walk and land H1 in the same commit once t3's export exists; the two must agree before either completes. Coordinate via one message, not by editing the other's file. |
| **H2** | t2 `models.js`: `sessionScopeOf`, `SESSION_SCOPED_KINDS` | t5 `lib/index.js`: `counts.byScope`, `sessions[]` in the Report | Import and use; do not re-implement the ownership rule. |
| **H3** | t4 `evaluation.js`: `evaluateRetrieval`, `ROUTES` | t5 `lib/index.js`: `context_prism_evaluate` | Wrap, map to `{ output, report }`, add `report.total`. No local metric math in `lib/`. |
| **H4** | t3 `sqlite_index.js` / `index.js`: `get diagnostics()` | t5 `lib/index.js`: `diagnostics.search` in the Report | Read the getter; no conditional per backend. |

### 6.4 Test-file ownership

| File | Owner | Mode |
| --- | --- | --- |
| `test/scope.test.js` | t2 | create |
| `test/ingest.test.js` | t3 | create |
| `test/evaluation.test.js` | t4 | create |
| `test/plugin.test.js`, `test/compat.test.js`, `test/host.test.js` | t5 | edit (tool-name lists gain `context_prism_report`: `host.test.js:80`, `compat.test.js:219`, `plugin.test.js:41`; the fallback-mount test's `registered.length` 6 → 7 at `host.test.js:97`) |
| `test/concurrency.test.js` | t6 | create |
| `test/engine.test.js`, `test/engine_fixes.test.js` | **nobody** | **frozen** — backward-compatibility gate. Both are in t2's and t3's verify commands but in no one's inScope: if your change breaks them, your change is wrong. `test/engine.test.js:126` additionally freezes `addFileIncremental`'s exact return shape. |
| `bench/**` | t4 | create |

---

## 7. Evaluation contract (t4)

### 7.1 Metrics

Notation for one query `q`: gold set `G_q` (chunk ids from the fixture), ranked list
`R_q = (r_1, …, r_K)` (1-based), `rank_q(g) = min{i : r_i = g}` (∞ when absent),
`N` = number of queries.

**Recall@K** — fraction of gold chunks present in the top K:

```
Recall@K(q) = |{ g ∈ G_q : rank_q(g) ≤ K }| / |G_q|
Recall@K    = (1/N) · Σ_q Recall@K(q)          # macro average; fixture guarantees |G_q| >= 1
```

`no-injection` scores `Recall@K = 0` because `R_q = ()`.

**MRR** (mean reciprocal rank, truncated at K):

```
RR(q) = 1 / rank_q(first gold in R_q)   if some g ∈ G_q has rank_q(g) ≤ K
      = 0                               otherwise
MRR   = (1/N) · Σ_q RR(q)               ∈ [0, 1]
```

**nDCG@10** — binary relevance (v0.9 labels are set membership, not graded):

```
DCG@10(q)  = Σ_{i=1..10} rel_i / log2(i + 1),      rel_i = 1 if r_i ∈ G_q else 0
IDCG@10(q) = Σ_{i=1..min(|G_q|, 10)} 1 / log2(i + 1)          # ≥ 1 when G_q ≠ ∅
nDCG@10(q) = DCG@10(q) / IDCG@10(q)                 # 0 when G_q = ∅
nDCG@10    = (1/N) · Σ_q nDCG@10(q)
```

Reported as `ndcgAt10` for every route, computed with `nDCGAt = 10` regardless of `k`.

**Token efficiency** — injected tokens per hit token; lower is better:

```
TE(q) = injectedTokens(q) / hitTokens(q)     if hitTokens(q) > 0
      = null                                 otherwise
tokenEfficiency(route) = mean over queries with non-null TE, or null if none
```

- `injectedTokens(q)` = `window.totalTokens` of the assembled window for that route
  (rendered cost, separators included, exactly what the model pays).
- `hitTokens(q)` = Σ `chunk.tokens` over **distinct** gold chunks that appear anywhere in the
  window (all sections except `Omitted Memory`).
- Documented approximation: compression is not attributed per item, so a compressed gold chunk
  contributes its original `chunk.tokens`. TE is therefore comparable **within** a release and
  across routes of the same run, not across different compressors.

**Ranking source for the metrics** = `retrieve(index, q, routeConfig)` mapped to chunk ids,
truncated to `k`. Ranking metrics measure ranking; token efficiency measures the assembled
window. Mixing them (metrics over the section-ordered window) would make MRR depend on section
grouping rather than relevance — explicitly forbidden.

### 7.2 Routes (exact names and semantics)

| Route name (exact) | `RetrievalConfig` | Assembly | `rankedIds` | `injectedTokens` |
| --- | --- | --- | --- | --- |
| `no-injection` | n/a | **none** — the baseline "do not inject ContextPrism context at all" | `[]` | `0` |
| `bm25-only` | `new RetrievalConfig({ useSemantic: false, topK: 40 })` | `buildContext` with that config | `retrieve()` ids | `window.totalTokens` |
| `hybrid` | `new RetrievalConfig({ topK: 40 })` (shipping default: BM25 + embedding) | `buildContext` default | `retrieve()` ids | `window.totalTokens` |

Rules:

- The three names are string literals, lowercase, hyphenated exactly as written. They are the
  keys of `byRoute` and the values of `routes`.
- `no-injection` is the **control**. It MUST score `Recall@K = 0`, `MRR = 0`, `ndcgAt10 = 0`,
  `injectedTokens = 0`, `tokenEfficiency = null`. A harness that cannot reproduce those
  numbers is measuring noise; a test MUST assert them.
- Every query carries an optional `sessionId`; when present it is passed as `scope` for that
  query in every route, so the benchmark measures the session-scoped engine.
- Route results MUST be computed independently (fresh engine or `clearCaches()` per route) —
  see D15.

### 7.3 Fixture

- `bench/corpus/**` — committed text fixtures.
- Chunk ids MUST be stable across working directories: `bench:<path-relative-to-bench-corpus>#<n>`
  (built explicitly by `loadBenchFixture()`, **not** from `ingestFile`'s path-derived ids).
- `bench/queries.jsonl` — one JSON object per line, ≥ 30 lines:
  `{"id":"q01","query":"…","goldChunkIds":["bench:agents.md#0"],"sessionId":null}`
- Invariants a test MUST assert: every line parses; `id` unique; `goldChunkIds` non-empty;
  every gold id exists in the loaded corpus; ≥ 30 queries; the whole benchmark finishes in a
  few seconds (regression-gate budget).

---

## 8. Verify commands and parallel safety

### 8.1 Per-task commands

Run from the repo root (`/Users/openclaw/Documents/plugins/repo`), in this order. A task's
`commandsRun` evidence must match its own contract exactly.

| Task | Commands (exact) |
| --- | --- |
| **t1** | `test -f docs/SPEC-SESSION-ISOLATION.md` · `grep -q 'D12' docs/SPEC-SESSION-ISOLATION.md` · `grep -q 'Recall@K' docs/SPEC-SESSION-ISOLATION.md` · `grep -q 'no-injection' docs/SPEC-SESSION-ISOLATION.md` |
| **t2** | `node --test test/engine.test.js test/engine_fixes.test.js` · `node --test test/scope.test.js` |
| **t3** | `node --test test/engine.test.js` · `node --test test/ingest.test.js` |
| **t4** | `node --test test/evaluation.test.js` |
| **t5** | `node --test test/plugin.test.js test/compat.test.js test/host.test.js` |
| **t6** | `npm test` · `node --test test/concurrency.test.js` |

Content requirements that ride on those commands (not extra commands):

- **t3**: `test/ingest.test.js` MUST exercise the CJK claim on **both** backends — `LocalIndex`
  and `SqliteIndex` (including the §4.6.1 migration path on a pre-existing DB) — plus the
  symlink-loop termination and the `.lceignore` case.
- **t2**: `test/scope.test.js` MUST cover both directions (A cannot see B, B cannot see A), the
  cache-key hit/miss behaviour (D14), and the preference-ordering change.
- **t4**: exact-value assertions MUST go through `recallAtK` / `reciprocalRank` / `ndcgAtK`
  applied to **literal ranked-id arrays**, which are tokenizer-independent. At most one
  end-to-end assertion may touch the fixture corpus, and it must be threshold-based
  (`recallAtK >= x`), never an exact count — otherwise t3's CJK bigrams / BM25 statistics
  change would invalidate t4's test and the two tasks would gate on each other.

### 8.2 Parallel-safety rules

1. **Never run `npm test` before t6.** Its script is a fixed list that includes
   `test/plugin.test.js` / `test/compat.test.js` / `test/host.test.js` — t5's in-flight files.
   A red result there is not your defect and not actionable.
2. **Never run bare `node --test`** (no arguments): it discovers every `test/*.test.js`,
   including other members' half-written files.
3. Run only the files named in your row. If a file in your row belongs to someone else
   (`test/engine.test.js`, `test/engine_fixes.test.js`) it is a **frozen gate**, read-only.
4. If a frozen-gate test fails because of your change, fix your change. Do not edit, skip, or
   rename a frozen test.
5. Cross-task imports (H1–H4) are the only allowed dependencies. If a handoff export is not
   present yet, do not create a local copy of its logic — wait, or message the producer.
6. Two members must never have the same file open for edit (§6). If you need a change in a
   file you do not own, message the owner (or the captain) instead of editing it.

### 8.3 Release gate (captain/reviewer, not a member's completion criterion)

`package.json` is frozen, so the v0.9 aggregate suite is the explicit union:

```bash
node --test test/engine.test.js test/engine_fixes.test.js test/plugin.test.js \
  test/compat.test.js test/host.test.js test/scope.test.js test/ingest.test.js \
  test/evaluation.test.js test/concurrency.test.js
```

Expected: all green. `t6`'s own completion still uses its contract commands (`npm test` +
`node --test test/concurrency.test.js`).

---

## 9. Out of scope, limitations, and honest notes

### 9.1 Deliberately not fixed in v0.9

- `embeddingCache` unbounded growth (D16).
- `fs.watch(projectRoot, { recursive: true })` observes the whole tree; a per-watch exclude is
  not available in the Node API. Ingestion-side `.lceignore` limits what is *indexed*, not what
  is *watched*.
- `prioritize()`'s constant terms (`kindBase * 0.1`, etc.) remain un-calibrated; v0.9 gives the
  evaluator that would justify changing them, it does not change them.
- Python tree (`python/`) is not maintained in this release.
- The `python/` ↔ `engine/` behavioural drift documented in `docs/analysis/ROADMAP-REVIEW.md` §3.3.

### 9.2 Known limitation: multiple processes on one SQLite index

Two host processes sharing one `.lce/index.db` still cannot interleave safely at the *write*
level (no cross-process lock is added). Mitigations that hold: chunk ids are deterministic and
inserts are upserts (`ON CONFLICT(id) DO UPDATE`), and the cursor is written with `max`, so
duplicate work converges to the same rows and never rewinds. Isolation (R-A) is unaffected —
it is enforced at read time from persisted chunk metadata, so a chunk written by another
process is filtered exactly like one written by this process.

### 9.3 What this spec does not claim

- It does not claim the embedding is semantic; `hash n-gram` is lexical. `hybrid` is
  "BM25 + lexical-similarity", and v0.9 measures whether that beats `bm25-only` instead of
  asserting it.
- It does not claim per-session isolation protects against a caller that deliberately passes
  another session's id; it protects the automatic path, which always derives the id from the
  host session object.

---

## 10. Traceability to the t1 acceptance criteria

| Acceptance criterion | Section |
| --- | --- |
| Isolation invariant: which kinds are session-scoped vs project-scoped, plus the exact rule | §2.1, §3.1 (I1–I4), §3.3 |
| Concurrency invariant: N sessions, own history only, idempotent capture, no global decides index path | §3.2 (C1–C6), §4.3.4, §4.7.2–4.7.3 |
| Exact signatures: `RetrievalConfig.scope`, `buildContext` scope, both cache keys, capture guard, `evaluateRetrieval()`, `context_prism_report` | §4.1–4.8 |
| Defect table D1–D12 with file, current behaviour, required behaviour, owner | §5.1 (plus §5.2 for D13–D16) |
| File-ownership table for every file under `engine/` and `lib/`, no duplicates | §6.1, §6.2 |
| Recall@K, MRR, nDCG@10, token efficiency with formulas, and the three route names | §7.1, §7.2 |
| Exact verify commands per implementation task, non-gating on in-flight files | §8.1, §8.2 |

---

## 11. Change log of this document

| Version | Date | Change |
| --- | --- | --- |
| 1.0 | v0.9 kickoff | Initial normative contract for R-A / R-B. |

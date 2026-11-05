// Score-scale and capture-cursor parity: the two regressions t6's verification
// found, pinned so they cannot come back.
//
// F1 — `normalizeHitScore` used to assume SQLite FTS5 `rank` values are O(1e-6)
//      (`Math.min(0.999, |rank| * 1e6 / (|rank| * 1e6 + 1))`). Measured over the
//      whole bench fixture the real ranks span -2.9e-6 (near-tie) to -28.8
//      (strong hit), so 407 of 410 hits were mapped to exactly 0.999: relevance
//      became a constant, the ordering the backend had already got right was
//      discarded, and sqlite bm25-only collapsed to R@10 0.463 / MRR 0.144
//      against LocalIndex's 0.976 / 0.785.
//
//      The fix maps the magnitude through one saturating curve, |s| / (|s| + 1),
//      with no per-backend constant and no clamp, so both regimes survive: the
//      near-tie stays strictly ordered at the bottom of the range and the strong
//      hit spreads across the top. LocalIndex's positive branch is unchanged.
//
// F2 — `captureSessionEvents` read `seq >= persisted`, so a no-op capture
//      re-read the event at the persisted cursor, re-upserted its chunk,
//      overcounted `added` and bumped `index.revision` — which invalidates every
//      cache key derived from the revision, on every turn. The cursor is now
//      exclusive and its *presence* (not its value) distinguishes "nothing
//      captured yet" from "captured up to seq 0".
//
// Both-backend coverage is deliberate: the shipping default backend is SQLite,
// so a divergence that only shows up there is exactly what must fail a test.

import test from "node:test";
import assert from "node:assert/strict";

import { evaluateRetrieval, loadBenchFixture } from "../engine/evaluation.js";
import { LocalContextEngine } from "../engine/engine.js";
import { LocalIndex } from "../engine/index.js";
import { SqliteIndex } from "../engine/sqlite_index.js";
import { Chunk, SourceKind } from "../engine/models.js";
import { RetrievalConfig, normalizeHitScore, retrieve } from "../engine/retrieval.js";

const K = 10;
const LEGACY_CEILING = 0.999;

function indexesFrom(chunks) {
  const local = new LocalIndex();
  local.addMany(chunks);
  const sqlite = new SqliteIndex(":memory:");
  sqlite.addMany(chunks);
  return { local, sqlite };
}

/** Relevance-only scoring: isolates the relevance map from recency/source/priority. */
function relevanceOnly(topK = K) {
  return new RetrievalConfig({
    useSemantic: false,
    recencyWeight: 0,
    sourceWeight: 0,
    priorityWeight: 0,
    topK,
  });
}

function ids(items) {
  return items.map((item) => item.chunk.id);
}

/**
 * Sort each run of exactly-equal scores by chunk id.
 *
 * `retrieve()` breaks score ties by id, a backend's own hit list need not. An
 * order comparison must therefore treat equal scores as unordered — otherwise
 * the assertion would fail on a legitimate tie instead of on lost ordering.
 */
function tieNormalizedIds(hits) {
  const out = [];
  let run = [];
  const flush = () => {
    run.sort((a, b) => String(a.chunk.id).localeCompare(String(b.chunk.id)));
    for (const hit of run) out.push(hit.chunk.id);
    run = [];
  };
  for (const hit of hits) {
    if (run.length > 0 && run[run.length - 1].score !== hit.score) flush();
    run.push(hit);
  }
  flush();
  return out;
}

function spearman(left, right) {
  const common = left.filter((id) => right.includes(id));
  if (common.length < 2) return null;
  const n = common.length;
  const d2 = common.reduce((sum, id) => {
    const delta = left.indexOf(id) - right.indexOf(id);
    return sum + delta * delta;
  }, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

function jaccard(left, right) {
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 1;
  const inter = left.filter((id) => right.includes(id)).length;
  return inter / union.size;
}

// ---------------------------------------------------------------------------
// F1 — the relevance map keeps the backend's ordering instead of clamping it
// ---------------------------------------------------------------------------

test("normalizeHitScore is injective and strictly monotone across both observed FTS5 regimes", () => {
  const { chunks, queries } = loadBenchFixture({ dir: "bench" });
  const { sqlite } = indexesFrom(chunks);

  const allRanks = [];
  for (const query of queries) {
    for (const hit of sqlite.searchWithScores(query.query, K)) allRanks.push(hit.score);
  }
  assert.ok(allRanks.length > 300, `expected a real corner of rank values, got ${allRanks.length}`);

  // The fixture must contain both regimes, otherwise this test proves nothing
  // about the one it happens to skip.
  const magnitudes = allRanks.map(Math.abs);
  assert.ok(Math.min(...magnitudes) < 1e-4, "the fixture must contain near-ties (O(1e-6) ranks)");

  // 1. Nothing piles up at the old clamp point.
  const clamped = allRanks.filter((rank) => normalizeHitScore(rank) === LEGACY_CEILING).length;
  assert.equal(clamped, 0, "no hit may land on the old 0.999 ceiling");

  // 2. No inversions, and no collapsing of distinguishable scores.
  const distinct = [...new Set(allRanks)].sort((a, b) => Math.abs(a) - Math.abs(b));
  let inversions = 0;
  let collapses = 0;
  for (let i = 1; i < distinct.length; i += 1) {
    const previous = normalizeHitScore(distinct[i - 1]);
    const next = normalizeHitScore(distinct[i]);
    if (next < previous) inversions += 1;
    if (next === previous) {
      // Two doubles this close are the same rank: any smooth map into [0,1]
      // rounds them together. Anything coarser than one double ULP is a bug.
      const gap = Math.abs(distinct[i] - distinct[i - 1]) / Math.max(Number.MIN_VALUE, Math.abs(distinct[i - 1]));
      if (gap > 1e-12) collapses += 1;
    }
  }
  assert.equal(inversions, 0, "the map may never invert the backend's ordering");
  assert.equal(collapses, 0, "distinguishable backend scores must stay distinguishable");

  // 3. The map is bounded away from both ends for finite scores: no saturation
  //    at 1, and a real match never reads as exactly 0.
  for (const rank of allRanks) {
    const mapped = normalizeHitScore(rank);
    assert.ok(mapped > 0 && mapped < 1, `finite rank ${rank} mapped to ${mapped}`);
  }

  // 4. Strictly increasing where it matters: on the distinct magnitudes with a
  //    meaningful gap, mapped values rise with rank quality.
  const meaningful = distinct.filter((rank, i) => i === 0 || Math.abs(rank) - Math.abs(distinct[i - 1]) > 1e-9 * Math.abs(rank));
  for (let i = 1; i < meaningful.length; i += 1) {
    assert.ok(
      normalizeHitScore(meaningful[i]) > normalizeHitScore(meaningful[i - 1]),
      `strict monotonicity broken between ${meaningful[i - 1]} and ${meaningful[i]}`,
    );
  }
});

test("LocalIndex and SqliteIndex score the same fixture to within the parity band", async () => {
  const { chunks, queries } = loadBenchFixture({ dir: "bench" });
  const { local, sqlite } = indexesFrom(chunks);

  const localReport = await evaluateRetrieval({ index: local, queries, routes: ["bm25-only"], k: K });
  const sqliteReport = await evaluateRetrieval({ index: sqlite, queries, routes: ["bm25-only"], k: K });
  const localRoute = localReport.byRoute["bm25-only"];
  const sqliteRoute = sqliteReport.byRoute["bm25-only"];

  assert.equal(localRoute.route, "bm25-only");
  assert.equal(sqliteRoute.route, "bm25-only");
  assert.equal(localRoute.injectedTokens > 0, true, "the route must actually assemble windows");

  // Both backends must be good, so "both bad" cannot satisfy the parity check.
  const floor = 0.95;
  assert.ok(localRoute.recallAtK >= floor, `LocalIndex R@${K} ${localRoute.recallAtK.toFixed(3)} below ${floor}`);
  assert.ok(
    sqliteRoute.recallAtK >= floor,
    `SqliteIndex R@${K} ${sqliteRoute.recallAtK.toFixed(3)} below ${floor} (the clamping defect measured 0.463 here)`,
  );

  // The measured claim: sqlite within 0.02 of local on recall, same band on the
  // rank-quality metrics. 0.05 leaves room for the two BM25 implementations
  // ordering near-ties differently; it is far tighter than the 0.64/0.62 gaps
  // the clamp produced.
  assert.ok(
    Math.abs(sqliteRoute.recallAtK - localRoute.recallAtK) <= 0.02,
    `Recall@${K} diverged: local ${localRoute.recallAtK.toFixed(3)} vs sqlite ${sqliteRoute.recallAtK.toFixed(3)}`,
  );
  for (const metric of ["mrr", "ndcgAt10"]) {
    assert.ok(
      Math.abs(sqliteRoute[metric] - localRoute[metric]) <= 0.05,
      `${metric} diverged: local ${localRoute[metric].toFixed(3)} vs sqlite ${sqliteRoute[metric].toFixed(3)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// F1 — ordering equivalence, not just thresholds
// ---------------------------------------------------------------------------

test("both backends preserve their own hit order, and agree wherever they natively agree", () => {
  const { chunks, queries } = loadBenchFixture({ dir: "bench" });
  const { local, sqlite } = indexesFrom(chunks);
  const config = relevanceOnly();

  let preservedLocal = 0;
  let preservedSqlite = 0;
  let nativeAgreement = 0;
  let reconstructed = 0;
  const rhos = [];
  const overlaps = [];
  let topOneAgreements = 0;

  for (const query of queries) {
    const rawLocal = local.searchWithScores(query.query, K);
    const rawSqlite = sqlite.searchWithScores(query.query, K);
    const rawLocalIds = tieNormalizedIds(rawLocal);
    const rawSqliteIds = tieNormalizedIds(rawSqlite);

    const gotLocalIds = ids(retrieve(local, query.query, config));
    const gotSqliteIds = ids(retrieve(sqlite, query.query, config));

    // Each backend's scored order must reproduce its own hit order. This is the
    // assertion the clamp fails: with every relevance equal to 0.999 the final
    // order falls back to the id tie-break, not to the backend's ranking.
    if (gotLocalIds.join("\u0000") === rawLocalIds.join("\u0000")) preservedLocal += 1;
    if (gotSqliteIds.join("\u0000") === rawSqliteIds.join("\u0000")) preservedSqlite += 1;

    // Where the two backends already agree on the order, the scored pipeline
    // must reproduce that shared order on both sides. Dynamic, not a curated
    // list: it cannot go stale, and it fails if either side reorders.
    if (rawLocalIds.join("\u0000") === rawSqliteIds.join("\u0000")) {
      nativeAgreement += 1;
      if (gotLocalIds.join("\u0000") === rawLocalIds.join("\u0000") && gotSqliteIds.join("\u0000") === rawSqliteIds.join("\u0000")) {
        reconstructed += 1;
      }
    }

    if (gotLocalIds[0] === gotSqliteIds[0]) topOneAgreements += 1;
    const rho = spearman(gotLocalIds, gotSqliteIds);
    if (rho !== null) rhos.push(rho);
    overlaps.push(jaccard(gotLocalIds, gotSqliteIds));
  }

  const total = queries.length;
  assert.equal(preservedLocal, total, "LocalIndex order must survive scoring unchanged");
  assert.equal(preservedSqlite, total, "SqliteIndex order must survive scoring unchanged (the clamp broke this)");

  assert.ok(nativeAgreement >= 1, "the fixture must contain at least one natively-agreeing query or the parity check is vacuous");
  assert.equal(reconstructed, nativeAgreement, "wherever the backends natively agree, both must reproduce that order");

  // Aggregate ordering equivalence. The two backends use different BM25
  // implementations, so exact top-10 equality is not expected; a constant
  // relevance collapses these numbers towards 0 instead.
  const meanRho = rhos.reduce((sum, value) => sum + value, 0) / Math.max(1, rhos.length);
  const meanOverlap = overlaps.reduce((sum, value) => sum + value, 0) / overlaps.length;
  assert.ok(meanRho >= 0.85, `mean rank correlation ${meanRho.toFixed(3)} below 0.85`);
  assert.ok(meanOverlap >= 0.8, `mean top-${K} overlap ${meanOverlap.toFixed(3)} below 0.8`);
  assert.ok(topOneAgreements / total >= 0.9, `top-1 agreement ${topOneAgreements}/${total} below 90%`);
});

// ---------------------------------------------------------------------------
// F2 — a no-op capture must not churn the index revision
// ---------------------------------------------------------------------------

function sessionFixture(id, turns) {
  const events = [];
  let seq = 1;
  for (let turn = 0; turn < turns; turn += 1) {
    events.push({ seq, time: Date.now(), type: "user/message", data: { role: "user", content: [{ type: "text", text: `${id} question ${turn}` }] } });
    seq += 1;
    events.push({ seq, time: Date.now(), type: "assistant/message", data: { message: { content: [{ type: "text", text: `${id} answer ${turn}` }] } } });
    seq += 1;
  }
  return { id, header: {}, events };
}

test("a no-op capture neither bumps index.revision nor overcounts added", () => {
  const engine = new LocalContextEngine({ index: new LocalIndex() });
  const session = sessionFixture("sess-a", 2);

  const first = engine.captureSessionEvents({ session });
  assert.equal(first.added, 4, "two turns produce two history chunks each");
  const revisionAfterFirst = engine.index.revision;
  const chunksAfterFirst = engine.index.size;

  // Same cursor the plugin passes: the persisted one. Nothing new to read.
  const noop = engine.captureSessionEvents({ session, cursor: engine.sessionCursor(session.id) });
  assert.equal(noop.added, 0, "a no-op capture must not report the boundary event as added");
  assert.equal(noop.reentered, false);
  assert.equal(engine.index.revision, revisionAfterFirst, "a no-op capture must not invalidate rev-keyed caches");
  assert.equal(engine.index.size, chunksAfterFirst, "no chunk may be re-upserted");

  // A revision-keyed cache entry therefore survives the no-op.
  const keyBefore = engine._retrievalCacheKey("anything", new RetrievalConfig(), null);
  engine.captureSessionEvents({ session, cursor: engine.sessionCursor(session.id) });
  assert.equal(engine._retrievalCacheKey("anything", new RetrievalConfig(), null), keyBefore);
});

test("a genuine new event is captured exactly once, then the cursor is quiet again", () => {
  const engine = new LocalContextEngine({ index: new LocalIndex() });
  const session = sessionFixture("sess-b", 1);
  engine.captureSessionEvents({ session });

  const revisionBefore = engine.index.revision;
  const sizeBefore = engine.index.size;
  const cursorBefore = engine.sessionCursor(session.id);

  session.events.push({
    seq: 3,
    time: Date.now(),
    type: "user/message",
    data: { role: "user", content: [{ type: "text", text: "sess-b follow-up question" }] },
  });

  const next = engine.captureSessionEvents({ session, cursor: engine.sessionCursor(session.id) });
  assert.equal(next.added, 1, "exactly the new event is new");
  assert.equal(next.cursor, 3);
  assert.equal(engine.index.size, sizeBefore + 1, "one chunk added, nothing re-upserted");
  // A real write must move the revision (LocalIndex charges two per upsert:
  // remove + add, so the exact total is not the point). What the defect broke
  // was the *no-op* path, asserted below.
  assert.ok(engine.index.revision > revisionBefore, "a genuine new event must move the revision");
  assert.ok(engine.sessionCursor(session.id) > cursorBefore);

  const settledRevision = engine.index.revision;
  const settledSize = engine.index.size;
  const repeat = engine.captureSessionEvents({ session, cursor: engine.sessionCursor(session.id) });
  assert.equal(repeat.added, 0, "re-capturing after the new event is a no-op");
  assert.equal(engine.index.revision, settledRevision);
  assert.equal(engine.index.size, settledSize);
});

test("capture is exclusive even when the session's first event is seq 0", () => {
  const engine = new LocalContextEngine({ index: new LocalIndex() });
  const session = {
    id: "sess-zero",
    header: {},
    events: [{ seq: 0, time: Date.now(), type: "user/message", data: { role: "user", content: [{ type: "text", text: "first event has seq 0" }] } }],
  };

  const first = engine.captureSessionEvents({ session });
  assert.equal(first.added, 1, "seq 0 is a legal event and must be captured");
  assert.equal(engine.sessionCursor(session.id), 0, "the cursor value stays 0, which is why presence is tracked separately");
  const revisionAfterFirst = engine.index.revision;

  // No new events: nothing may be re-read, even though the cursor value is 0.
  const noop = engine.captureSessionEvents({ session, cursor: 0 });
  assert.equal(noop.added, 0, "the seq-0 event was already captured");
  assert.equal(engine.index.revision, revisionAfterFirst, "no revision churn at the seq-0 boundary");

  session.events.push({ seq: 1, time: Date.now(), type: "user/message", data: { role: "user", content: [{ type: "text", text: "second event" }] } });
  const next = engine.captureSessionEvents({ session, cursor: 0 });
  assert.equal(next.added, 1, "only seq 1 is new");
  assert.equal(engine.sessionCursor(session.id), 1);
});

test("the FTS hits stay visible: no retrieved chunk is reported as zero relevance", () => {
  const { chunks } = loadBenchFixture({ dir: "bench" });
  const { sqlite } = indexesFrom(chunks);
  const items = retrieve(sqlite, "dynamic context window budget", new RetrievalConfig({ useSemantic: false, topK: 5 }));

  assert.ok(items.length > 0);
  for (const item of items) {
    const match = /bm25=(\S+)/.exec(item.reason);
    assert.ok(match, `the reason must expose the relevance it used: ${item.reason}`);
    assert.ok(Number(match[1]) > 0, `a match must not read as zero relevance: ${item.reason}`);
  }
});

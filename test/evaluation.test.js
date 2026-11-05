// Trusted retrieval evaluation (t4, spec §7).
//
// The exact-value assertions run against literal ranked-id lists and a tiny
// hand-built corpus, because those are tokenizer-independent: t3 may change
// CJK tokenization and BM25 statistics, and this suite must not gate on that
// (§8.1). At most one assertion here touches the committed fixture's ranking,
// and it is threshold-based.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  ROUTES,
  evaluateRetrieval,
  loadBenchFixture,
  ndcgAtK,
  recallAtK,
  reciprocalRank,
  tokenEfficiency,
} from "../engine/evaluation.js";
import { LocalIndex } from "../engine/index.js";
import { Chunk, SourceKind } from "../engine/models.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chunk({ id, content, kind = SourceKind.FILE, sessionId = null }) {
  return new Chunk({
    id,
    source: sessionId ? `session:${sessionId}` : "bench:test",
    kind,
    content,
    metadata: sessionId ? { sessionId } : {},
    timestamp: 1735689600,
  });
}

/** Three unrelated chunks: only one can match each query. */
function smallIndex() {
  const index = new LocalIndex();
  index.addMany([
    chunk({ id: "hand:c1", content: "alpha beta gamma" }),
    chunk({ id: "hand:c2", content: "delta epsilon" }),
    chunk({ id: "hand:c3", content: "zeta eta theta" }),
  ]);
  return index;
}

const SMALL_QUERIES = [
  { id: "h1", query: "alpha beta", goldChunkIds: ["hand:c1"] },
  { id: "h2", query: "delta", goldChunkIds: ["hand:c1", "hand:c2"] },
  { id: "h3", query: "omega", goldChunkIds: ["hand:c3"] },
];

function reportFor(queries, { routes = ["bm25-only"] } = {}) {
  return evaluateRetrieval({ index: smallIndex(), queries, routes });
}

// ---------------------------------------------------------------------------
// Metrics on literal ranked lists (§7.1) — exact, tokenizer-independent
// ---------------------------------------------------------------------------

test("recallAtK counts gold ids inside the cutoff", () => {
  assert.equal(recallAtK(["a", "b", "c"], ["b", "z"], 3), 0.5);
  assert.equal(recallAtK(["a", "b", "c"], ["c"], 2), 0);
  assert.equal(recallAtK(["a", "b", "c"], ["c"], 3), 1);
  assert.equal(recallAtK(["a", "b"], ["a", "b"], 10), 1);
  assert.equal(recallAtK([], ["a"], 10), 0);
  // A missing gold set is not a free 1.0.
  assert.equal(recallAtK(["a"], [], 10), 0);
  // Duplicate ids never inflate the denominator.
  assert.equal(recallAtK(["a", "a"], ["a", "a"], 10), 1);
});

test("reciprocalRank uses the first gold hit and truncates at k", () => {
  assert.equal(reciprocalRank(["a", "b", "c"], ["b"], 10), 0.5);
  assert.equal(reciprocalRank(["b", "a"], ["b"], 10), 1);
  assert.equal(reciprocalRank(["x", "y"], ["b"], 10), 0);
  assert.equal(reciprocalRank(["a", "b"], ["b"], 1), 0);
  assert.equal(reciprocalRank(["a", "b", "c"], ["c", "b"], 10), 0.5);
  assert.equal(reciprocalRank([], ["b"], 10), 0);
});

test("ndcgAtK is binary-relevance DCG over IDCG, truncated at k", () => {
  // Perfect single-gold ranking.
  assert.equal(ndcgAtK(["b", "a"], ["b"], 10), 1);
  // Best possible is 1/log2(3) when the only gold is second.
  assert.equal(ndcgAtK(["a", "b"], ["b"], 10), 1 / Math.log2(3));
  // Nothing retrieved.
  assert.equal(ndcgAtK([], ["b"], 10), 0);
  // Truncation: the gold at position 2 is outside k = 1.
  assert.equal(ndcgAtK(["a", "b"], ["b"], 1), 0);
  // Two-gold ideal: one of two found at rank 1 is 1 / (1 + 1/log2(3)).
  assert.equal(ndcgAtK(["b", "x"], ["b", "c"], 10), 1 / (1 + 1 / Math.log2(3)));
  // Empty gold set scores 0 rather than dividing by zero.
  assert.equal(ndcgAtK(["a"], [], 10), 0);
});

test("tokenEfficiency is null without a hit and a plain ratio otherwise", () => {
  assert.equal(tokenEfficiency(100, 50), 2);
  assert.equal(tokenEfficiency(100, 100), 1);
  assert.equal(tokenEfficiency(10, 0), null);
  assert.equal(tokenEfficiency(0, 0), null);
  assert.equal(tokenEfficiency(Number.NaN, 10), null);
});

// ---------------------------------------------------------------------------
// Hand-built corpus: exact report values
// ---------------------------------------------------------------------------

test("hand-built corpus produces exact Recall@K and MRR", async () => {
  const report = await reportFor(SMALL_QUERIES);

  // q1: gold at rank 1                -> recall 1,   RR 1
  // q2: one of two golds at rank 1    -> recall 0.5, RR 1
  // q3: no candidate at all           -> recall 0,   RR 0
  assert.deepEqual(
    report.perQuery.map((query) => [
      query.id,
      query.byRoute["bm25-only"].recallAtK,
      query.byRoute["bm25-only"].mrr,
    ]),
    [
      ["h1", 1, 1],
      ["h2", 0.5, 1],
      ["h3", 0, 0],
    ],
  );

  assert.equal(report.byRoute["bm25-only"].recallAtK, 0.5);
  assert.equal(report.byRoute["bm25-only"].mrr, (1 + 1 + 0) / 3);
  assert.equal(report.byRoute["bm25-only"].hitRate, 2 / 3);

  // nDCG is checked against the closed form rather than a literal.
  const expectedNdcg = (1 + 1 / (1 + 1 / Math.log2(3)) + 0) / 3;
  assert.equal(report.byRoute["bm25-only"].ndcgAt10, expectedNdcg);

  // Token efficiency averages only the queries that produced a hit.
  const bm25 = report.byRoute["bm25-only"];
  assert.equal(bm25.injectedTokens, report.perQuery.reduce((sum, query) => sum + query.byRoute["bm25-only"].injectedTokens, 0));
  assert.ok(bm25.tokenEfficiency === null || bm25.tokenEfficiency > 0);
});

test("metrics are computed on chunk ids, not on content substrings", async () => {
  // The gold id exists, but nothing in the corpus contains the query text. The
  // old substring check would have reported a hit for a chunk whose content
  // includes the query; here a hit requires the *id* to be retrieved.
  const index = new LocalIndex();
  index.addMany([
    chunk({ id: "hand:present", content: "the answer lives elsewhere" }),
    chunk({ id: "hand:absent", content: "unrelated material" }),
  ]);
  const report = await evaluateRetrieval({
    index,
    queries: [
      { id: "s1", query: "the answer lives elsewhere", goldChunkIds: ["hand:absent"] },
    ],
    routes: ["bm25-only"],
  });
  assert.equal(report.byRoute["bm25-only"].recallAtK, 0);
  assert.deepEqual(report.perQuery[0].byRoute["bm25-only"].rankedIds, ["hand:present"]);
  assert.deepEqual(report.perQuery[0].byRoute["bm25-only"].hitIds, []);
});

// ---------------------------------------------------------------------------
// Routes (§7.2)
// ---------------------------------------------------------------------------

test("the three routes are reported side by side with the exact names", () => {
  return reportFor(SMALL_QUERIES, { routes: ROUTES }).then((report) => {
    assert.deepEqual(report.routes, ["no-injection", "bm25-only", "hybrid"]);
    assert.deepEqual(Object.keys(report.byRoute), ["no-injection", "bm25-only", "hybrid"]);
    assert.equal(ROUTES.length, 3);
    for (const route of report.routes) {
      const metrics = report.byRoute[route];
      assert.equal(metrics.route, route);
      for (const field of ["recallAtK", "mrr", "ndcgAt10", "tokenEfficiency", "injectedTokens", "hitTokens", "hitRate"]) {
        assert.ok(field in metrics, `${route} is missing ${field}`);
      }
      for (const query of report.perQuery) {
        assert.ok(query.byRoute[route], `${query.id} is missing route ${route}`);
      }
    }
  });
});

test("the no-injection baseline scores exactly zero", async () => {
  const report = await reportFor(SMALL_QUERIES, { routes: ROUTES });
  const control = report.byRoute["no-injection"];

  assert.equal(control.recallAtK, 0);
  assert.equal(control.mrr, 0);
  assert.equal(control.ndcgAt10, 0);
  assert.equal(control.injectedTokens, 0);
  assert.equal(control.hitTokens, 0);
  assert.equal(control.hitRate, 0);
  assert.equal(control.tokenEfficiency, null);

  for (const query of report.perQuery) {
    const entry = query.byRoute["no-injection"];
    assert.deepEqual(entry.rankedIds, []);
    assert.deepEqual(entry.hitIds, []);
    assert.equal(entry.firstHitRank, null);
    assert.equal(entry.recallAtK, 0);
    assert.equal(entry.mrr, 0);
    assert.equal(entry.ndcgAt10, 0);
    assert.equal(entry.injectedTokens, 0);
    assert.equal(entry.tokenEfficiency, null);
  }

  // The control is only meaningful because another route does find signal.
  assert.ok(report.byRoute["bm25-only"].recallAtK > 0);
  assert.ok(report.byRoute["bm25-only"].injectedTokens > 0);
});

test("routes are isolated: order and repetition never change a route's metrics", async () => {
  const forward = await evaluateRetrieval({
    index: smallIndex(),
    queries: SMALL_QUERIES,
    routes: ["no-injection", "bm25-only", "hybrid"],
  });
  const reversed = await evaluateRetrieval({
    index: smallIndex(),
    queries: SMALL_QUERIES,
    // `hybrid` first and `bm25-only` last: if the two shared a cache entry, a
    // hybrid ranking would be served for the bm25-only route here (D15).
    routes: ["hybrid", "bm25-only", "no-injection"],
  });
  const repeated = await evaluateRetrieval({
    index: smallIndex(),
    queries: SMALL_QUERIES,
    routes: ["no-injection", "bm25-only", "hybrid"],
  });

  assert.deepEqual(reversed.byRoute["bm25-only"], forward.byRoute["bm25-only"]);
  assert.deepEqual(reversed.byRoute["hybrid"], forward.byRoute["hybrid"]);
  assert.deepEqual(repeated.byRoute, forward.byRoute);
  assert.deepEqual(repeated.perQuery, forward.perQuery);
  assert.deepEqual(reportStripElapsed(repeated), reportStripElapsed(forward));
});

test("evaluation is read-only: the index revision does not move", async () => {
  const index = smallIndex();
  const before = index.revision;
  await evaluateRetrieval({ index, queries: SMALL_QUERIES, routes: ROUTES });
  assert.equal(index.revision, before);
  assert.equal(index.size, 3);
});

test("a query's sessionId scopes its retrieval", async () => {
  const index = new LocalIndex();
  index.addMany([
    chunk({ id: "proj:notes", content: "alpha ledger balance sheet" }),
    chunk({ id: "sess:private", content: "alpha ledger balance sheet private note", kind: SourceKind.HISTORY, sessionId: "sess-b" }),
  ]);
  const query = { id: "scoped", query: "alpha ledger balance sheet", goldChunkIds: ["proj:notes"] };

  const unscoped = await evaluateRetrieval({ index, queries: [query], routes: ["bm25-only"] });
  const scoped = await evaluateRetrieval({
    index,
    queries: [{ ...query, sessionId: "sess-a" }],
    routes: ["bm25-only"],
  });

  assert.ok(unscoped.perQuery[0].byRoute["bm25-only"].rankedIds.includes("sess:private"));
  assert.equal(scoped.perQuery[0].sessionId, "sess-a");
  assert.deepEqual(scoped.perQuery[0].byRoute["bm25-only"].rankedIds, ["proj:notes"]);
  assert.equal(scoped.byRoute["bm25-only"].recallAtK, 1);
});

// ---------------------------------------------------------------------------
// The committed fixture
// ---------------------------------------------------------------------------

test("the committed fixture is well formed and stable", () => {
  const fixture = loadBenchFixture();

  assert.ok(fixture.queries.length >= 30, `expected at least 30 queries, got ${fixture.queries.length}`);
  assert.ok(fixture.chunks.length >= 20, `expected a real corpus, got ${fixture.chunks.length} chunks`);

  const chunkIds = new Set(fixture.chunks.map((entry) => entry.id));
  for (const entry of fixture.chunks) {
    assert.match(entry.id, /^bench:[^#]+#\d+$/, `unstable chunk id ${entry.id}`);
    assert.ok(entry.content.trim().length > 0, `empty chunk ${entry.id}`);
    assert.ok(entry.tokens > 0);
  }

  const seen = new Set();
  for (const query of fixture.queries) {
    assert.ok(query.id, "every fixture query carries an id");
    assert.ok(!seen.has(query.id), `duplicate query id ${query.id}`);
    seen.add(query.id);
    assert.ok(query.query.trim().length > 0, `${query.id} has no query text`);
    assert.ok(query.goldChunkIds.length >= 1, `${query.id} has no gold chunk ids`);
    for (const goldId of query.goldChunkIds) {
      assert.ok(chunkIds.has(goldId), `${query.id} labels a gold id outside the corpus: ${goldId}`);
    }
  }

  // Ids are a function of the corpus path, not of the working directory: an
  // absolute fixture directory yields exactly the same ids.
  const absolute = loadBenchFixture({ dir: fixtureDirectory() });
  assert.deepEqual(absolute.chunks.map((entry) => entry.id), fixture.chunks.map((entry) => entry.id));
  assert.deepEqual(absolute.queries, fixture.queries);
});

test("the committed fixture runs as a regression gate within the time budget", async () => {
  const fixture = loadBenchFixture();
  const index = new LocalIndex();
  index.addMany(fixture.chunks);

  const report = await evaluateRetrieval({ index, queries: fixture.queries });

  assert.deepEqual(report.routes, ["no-injection", "bm25-only", "hybrid"]);
  assert.equal(report.queryCount, fixture.queries.length);
  assert.equal(report.corpusSize, fixture.chunks.length);

  // Threshold floor, never an exact count: t3's tokenizer/BM25 statistics may
  // shift these numbers, but a drop below the floor is a real regression.
  const bm25 = report.byRoute["bm25-only"];
  const hybrid = report.byRoute["hybrid"];
  assert.ok(bm25.recallAtK >= 0.6, `bm25-only Recall@10 fell to ${bm25.recallAtK}`);
  assert.ok(hybrid.recallAtK >= 0.6, `hybrid Recall@10 fell to ${hybrid.recallAtK}`);
  assert.ok(bm25.hitRate >= 0.6, `bm25-only hit rate fell to ${bm25.hitRate}`);
  assert.ok(bm25.mrr > 0);
  assert.ok(bm25.injectedTokens > 0);
  assert.ok(hybrid.injectedTokens > 0);
  assert.ok(bm25.tokenEfficiency > 0);

  // The control stays at zero on the real corpus too.
  assert.equal(report.byRoute["no-injection"].recallAtK, 0);
  assert.equal(report.byRoute["no-injection"].tokenEfficiency, null);

  assert.ok(report.elapsedMs < 3000, `benchmark took ${report.elapsedMs}ms; it must stay a few seconds at most`);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("invalid input is rejected with a message that names the problem", async () => {
  const index = smallIndex();

  await assert.rejects(evaluateRetrieval({ queries: SMALL_QUERIES }), /index/);
  await assert.rejects(evaluateRetrieval({ index, queries: [] }), /non-empty array of labelled queries/);
  await assert.rejects(
    evaluateRetrieval({ index, queries: [{ id: "x", query: "  ", goldChunkIds: ["hand:c1"] }] }),
    /empty "query"/,
  );
  await assert.rejects(
    evaluateRetrieval({ index, queries: [{ id: "x", query: "alpha", goldChunkIds: [] }] }),
    /goldChunkIds/,
  );
  await assert.rejects(
    evaluateRetrieval({ index, queries: SMALL_QUERIES, routes: ["bm25-only", "semantic-only"] }),
    /unknown evaluation route "semantic-only"/,
  );
  await assert.rejects(evaluateRetrieval({ index, queries: SMALL_QUERIES, k: 0 }), /positive integer/);
});

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function fixtureDirectory() {
  return fileURLToPath(new URL("../bench", import.meta.url));
}

/** Drop the wall-clock field so two runs can be compared field by field. */
function reportStripElapsed(report) {
  const { elapsedMs, ...rest } = report;
  return rest;
}

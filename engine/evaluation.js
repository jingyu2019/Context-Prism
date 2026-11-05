// Trusted offline retrieval evaluation (spec §4.8 / §7, owner: t4).
//
// The old check decided a "hit" with `JSON.stringify(chunk).toLowerCase()
// .includes(expected)` over three hardcoded queries, which measured nothing:
// a chunk that merely mentions a word counted the same as a chunk that should
// rank first. This module replaces it with labelled queries, a ranked list per
// route and ranking metrics computed against gold chunk ids.
//
// Three routes are measured side by side:
//
//   no-injection  the control: do not inject ContextPrism context at all
//   bm25-only     lexical retrieval, semantic similarity disabled
//   hybrid        the shipping default (BM25 + embedding)
//
// The control is what makes the numbers interpretable: it MUST score zero on
// every ranking metric, because a harness that cannot reproduce "no signal"
// cannot be trusted about "signal" either.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LocalContextEngine } from "./engine.js";
import { Chunk, SourceKind, estimateTokens } from "./models.js";
import { RetrievalConfig, retrieve } from "./retrieval.js";

/** The exact route names (§7.2). Lowercase, hyphenated, never renamed. */
export const ROUTES = Object.freeze(["no-injection", "bm25-only", "hybrid"]);

const NO_INJECTION = "no-injection";
const HYBRID = "hybrid";

/** Route names as a set, for validation without re-creating it per call. */
const ROUTE_SET = new Set(ROUTES);

/** Default cutoff shared by Recall@K, MRR and the reported nDCG@10. */
const DEFAULT_K = 10;

/**
 * Fixed capture time for every fixture chunk.
 *
 * Recency decays over days, so a fixture stamped `Date.now()` would rank
 * differently tomorrow and the benchmark would stop being a regression gate.
 * One constant for all chunks also makes the recency term a uniform additive
 * constant, so it cannot reorder anything: the ranking is driven by relevance
 * and semantic similarity, exactly the two axes a route comparison is about.
 */
const BENCH_TIMESTAMP = 1735689600; // 2025-01-01T00:00:00Z

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CODE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".sh",
]);

// ---------------------------------------------------------------------------
// Metrics (§7.1) — pure functions over literal id lists, so they cannot depend
// on a tokenizer, an index or a clock. Exact-value tests assert against these.
// ---------------------------------------------------------------------------

/**
 * Fraction of the gold set that appears in the top `k`.
 *
 * @param {string[]} rankedIds ranked chunk ids, best first
 * @param {string[]} goldIds ids that should be retrieved
 * @param {number} [k=10]
 * @returns {number} in [0, 1]; 0 when the gold set is empty
 */
export function recallAtK(rankedIds, goldIds, k = DEFAULT_K) {
  const gold = uniqueIds(goldIds);
  if (gold.length === 0) return 0;
  const top = new Set(uniqueIds(rankedIds).slice(0, cutoff(k)));
  let found = 0;
  for (const id of gold) if (top.has(id)) found += 1;
  return found / gold.length;
}

/**
 * Reciprocal rank of the first gold chunk, truncated at `k`.
 *
 * @param {string[]} rankedIds ranked chunk ids, best first
 * @param {string[]} goldIds ids that should be retrieved
 * @param {number} [k=10]
 * @returns {number} 1/rank of the first hit in [0, 1], 0 when there is none
 */
export function reciprocalRank(rankedIds, goldIds, k = DEFAULT_K) {
  const gold = new Set(uniqueIds(goldIds));
  const top = uniqueIds(rankedIds).slice(0, cutoff(k));
  for (let index = 0; index < top.length; index += 1) {
    if (gold.has(top[index])) return 1 / (index + 1);
  }
  return 0;
}

/**
 * nDCG with binary relevance: labels are set membership, not grades (§7.1).
 *
 * DCG  = Σ_{i=1..k} rel_i / log2(i + 1)
 * IDCG = Σ_{i=1..min(|G|, k)} 1 / log2(i + 1)
 *
 * @param {string[]} rankedIds ranked chunk ids, best first
 * @param {string[]} goldIds ids that should be retrieved
 * @param {number} [k=10]
 * @returns {number} in [0, 1]; 0 when the gold set is empty
 */
export function ndcgAtK(rankedIds, goldIds, k = DEFAULT_K) {
  const gold = new Set(uniqueIds(goldIds));
  const limit = cutoff(k);
  const top = uniqueIds(rankedIds).slice(0, limit);
  let dcg = 0;
  for (let index = 0; index < top.length; index += 1) {
    if (gold.has(top[index])) dcg += 1 / Math.log2(index + 2);
  }
  let idcg = 0;
  const ideal = Math.min(gold.size, limit);
  for (let index = 0; index < ideal; index += 1) idcg += 1 / Math.log2(index + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Injected tokens per hit token; lower is better (§7.1).
 *
 * @param {number} injectedTokens rendered window cost, separators included
 * @param {number} hitTokens tokens of the gold chunks that reached the window
 * @returns {number|null} null when nothing was hit (so the ratio is meaningless)
 */
export function tokenEfficiency(injectedTokens, hitTokens) {
  if (!Number.isFinite(injectedTokens) || !Number.isFinite(hitTokens)) return null;
  if (hitTokens <= 0) return null;
  return Math.max(0, injectedTokens) / hitTokens;
}

// ---------------------------------------------------------------------------
// Fixture (§7.3)
// ---------------------------------------------------------------------------

/**
 * Load the committed benchmark fixture.
 *
 * Chunk ids are `bench:<path-relative-to-corpus>#<block>` and are assigned here,
 * not by `ingestFile()`: a path-derived id would embed the absolute working
 * directory and the same query file would stop matching after a checkout moved.
 *
 * @param {{dir?: string}} [options] `dir` defaults to "bench" next to `engine/`
 * @returns {{chunks: Chunk[], queries: Array<{id: string|null, query: string, goldChunkIds: string[], sessionId: string|null}>}}
 */
export function loadBenchFixture({ dir = "bench" } = {}) {
  const root = isAbsolutePath(dir) ? resolve(dir) : resolve(PACKAGE_ROOT, String(dir));
  const corpusDir = join(root, "corpus");
  const chunks = [];
  for (const relativePath of listCorpusFiles(corpusDir)) {
    const absolutePath = join(corpusDir, ...relativePath.split("/"));
    const text = readFileSync(absolutePath, "utf8");
    const kind = CODE_EXTENSIONS.has(extensionOf(relativePath)) ? SourceKind.CODE : SourceKind.FILE;
    const blocks = splitBlocks(text);
    blocks.forEach((content, index) => {
      chunks.push(
        new Chunk({
          id: `bench:${relativePath}#${index}`,
          source: `bench:${relativePath}`,
          kind,
          content,
          metadata: { bench: true, path: relativePath, block: index },
          timestamp: BENCH_TIMESTAMP,
          priority: 0,
        }),
      );
    });
  }
  const queries = readQueries(join(root, "queries.jsonl"));
  return { chunks, queries };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Run the benchmark across routes.
 *
 * Ranking metrics come from `retrieve(index, query, routeConfig)` truncated to
 * `k`; token efficiency comes from the assembled window. Mixing the two (taking
 * metrics over the window's section order) would make MRR depend on section
 * grouping rather than relevance, which §7.1 forbids.
 *
 * Each route gets its own engine instance, so a `hybrid` result can never be
 * served from a `bm25-only` cache entry (D15) — the comparison the evaluator
 * exists to make must be real.
 *
 * @param {object} options
 * @param {object} options.index read-only index (LocalIndex or SqliteIndex)
 * @param {Array<object>} options.queries labelled queries
 * @param {string[]} [options.routes=ROUTES] subset of ROUTES, order preserved
 * @param {number} [options.k=10]
 * @param {number} [options.nDCGAt=10]
 * @param {number} [options.maxTokens=4000]
 * @param {number} [options.reservedOutputTokens=800]
 * @param {RetrievalConfig|null} [options.retrievalConfig=null]
 * @param {object|null} [options.priorityConfig=null]
 * @returns {Promise<object>} EvaluationReport
 */
export async function evaluateRetrieval({
  index,
  queries,
  routes = ROUTES,
  k = DEFAULT_K,
  nDCGAt = DEFAULT_K,
  maxTokens = 4000,
  reservedOutputTokens = 800,
  retrievalConfig = null,
  priorityConfig = null,
} = {}) {
  const startedAt = nowMs();

  if (!index || (typeof index.search !== "function" && typeof index.searchWithScores !== "function")) {
    throw new TypeError("evaluateRetrieval requires an index with search()/searchWithScores()");
  }
  const labelled = normalizeQueries(queries);
  const selectedRoutes = normalizeRoutes(routes);
  const cutoffK = cutoff(k);
  const cutoffNdcg = cutoff(nDCGAt);
  if (!Number.isFinite(maxTokens) || !Number.isFinite(reservedOutputTokens) || maxTokens <= reservedOutputTokens) {
    // `buildContext` refuses a non-positive budget too; failing here names the
    // two inputs that produced it instead of an unrelated-looking engine error.
    throw new TypeError(
      `maxTokens (${maxTokens}) must be greater than reservedOutputTokens (${reservedOutputTokens})`,
    );
  }

  // One engine per injected route: nothing is shared between routes except the
  // read-only index.
  const engines = new Map();
  for (const route of selectedRoutes) {
    if (route === NO_INJECTION) continue;
    engines.set(route, new LocalContextEngine({ index }));
  }

  const perQuery = [];
  for (const item of labelled) {
    const byRoute = {};
    for (const route of selectedRoutes) {
      if (route === NO_INJECTION) {
        // The control: no context is assembled, so every ranking metric and the
        // injected cost are zero by construction (§7.2).
        byRoute[route] = {
          rankedIds: [],
          hitIds: [],
          firstHitRank: null,
          recallAtK: 0,
          mrr: 0,
          ndcgAt10: 0,
          injectedTokens: 0,
          hitTokens: 0,
          tokenEfficiency: null,
        };
        continue;
      }

      const engine = engines.get(route);
      // Per-query independence: an earlier query's cached ranking or packed
      // section may never be reused, so the report is a pure function of input.
      engine.clearCaches();
      const config = routeConfig(route, retrievalConfig, item.sessionId);

      const rankedIds = retrieve(index, item.query, config)
        .slice(0, cutoffK)
        .map((retrievedItem) => retrievedItem.chunk.id);

      const window = engine.buildContext({
        query: item.query,
        maxTokens,
        reservedOutputTokens,
        retrievalConfig: config,
        priorityConfig,
      });

      const gold = new Set(item.goldChunkIds);
      const hitIds = rankedIds.filter((id) => gold.has(id));
      const firstHitRank = firstRank(rankedIds, gold, cutoffK);
      const injectedTokens = window.totalTokens;
      const hitTokens = windowHitTokens(window, gold);

      byRoute[route] = {
        rankedIds,
        hitIds,
        firstHitRank,
        recallAtK: recallAtK(rankedIds, item.goldChunkIds, cutoffK),
        mrr: reciprocalRank(rankedIds, item.goldChunkIds, cutoffK),
        ndcgAt10: ndcgAtK(rankedIds, item.goldChunkIds, cutoffNdcg),
        injectedTokens,
        hitTokens,
        tokenEfficiency: tokenEfficiency(injectedTokens, hitTokens),
      };
    }

    perQuery.push({
      id: item.id,
      query: item.query,
      goldChunkIds: [...item.goldChunkIds],
      sessionId: item.sessionId,
      byRoute,
    });
  }

  const byRoute = {};
  for (const route of selectedRoutes) {
    byRoute[route] = aggregateRoute(route, perQuery);
  }

  return {
    schemaVersion: 1,
    k: cutoffK,
    nDCGAt: cutoffNdcg,
    routes: [...selectedRoutes],
    queryCount: labelled.length,
    corpusSize: corpusSizeOf(index),
    elapsedMs: Math.round((nowMs() - startedAt) * 1000) / 1000,
    byRoute,
    perQuery,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Per-route retrieval config, with the query's session id as its scope.
 *
 * A query without a `sessionId` measures the whole-index engine; a query with
 * one measures the session-scoped engine, which is the thing v0.9 changed.
 */
function routeConfig(route, base, sessionId) {
  const template = base ? { ...base } : {};
  const scope = sessionId !== null && sessionId !== undefined ? sessionId : template.scope ?? null;
  return new RetrievalConfig({
    ...template,
    // The route table in §7.2 pins topK = 40 for both injected routes; a caller
    // may override it, but never by accident of the metric cutoff.
    topK: Number.isFinite(template.topK) ? template.topK : 40,
    scope,
    useSemantic: route === HYBRID,
  });
}

/** Tokens of the distinct gold chunks that reached the window (§7.1). */
function windowHitTokens(window, gold) {
  const seen = new Set();
  let tokens = 0;
  for (const section of window.sections) {
    // The omission note describes dropped memory; it is not injected memory.
    if (section.title === "Omitted Memory") continue;
    for (const item of section.items) {
      const id = item.chunk.id;
      if (!gold.has(id) || seen.has(id)) continue;
      seen.add(id);
      const chunkTokens = Number.isFinite(item.chunk.tokens) && item.chunk.tokens > 0
        ? item.chunk.tokens
        : estimateTokens(item.chunk.content);
      tokens += chunkTokens;
    }
  }
  return tokens;
}

function aggregateRoute(route, perQuery) {
  const results = perQuery.map((query) => query.byRoute[route]);
  const efficiencies = results
    .map((result) => result.tokenEfficiency)
    .filter((value) => value !== null);
  const hits = results.filter((result) => result.hitIds.length > 0).length;
  return {
    route,
    recallAtK: mean(results.map((result) => result.recallAtK)),
    mrr: mean(results.map((result) => result.mrr)),
    ndcgAt10: mean(results.map((result) => result.ndcgAt10)),
    tokenEfficiency: efficiencies.length === 0 ? null : mean(efficiencies),
    injectedTokens: results.reduce((sum, result) => sum + result.injectedTokens, 0),
    hitTokens: results.reduce((sum, result) => sum + result.hitTokens, 0),
    hitRate: results.length === 0 ? 0 : hits / results.length,
  };
}

function mean(values) {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function firstRank(rankedIds, gold, k) {
  const top = rankedIds.slice(0, k);
  for (let index = 0; index < top.length; index += 1) {
    if (gold.has(top[index])) return index + 1;
  }
  return null;
}

function normalizeQueries(queries) {
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new TypeError("evaluateRetrieval requires a non-empty array of labelled queries");
  }
  return queries.map((item, position) => {
    if (!item || typeof item !== "object") {
      throw new TypeError(`query at index ${position} must be an object`);
    }
    if (typeof item.query !== "string" || item.query.trim() === "") {
      throw new TypeError(`query at index ${position} has an empty "query" text`);
    }
    if (!Array.isArray(item.goldChunkIds) || item.goldChunkIds.length === 0) {
      throw new TypeError(`query at index ${position} must have a non-empty "goldChunkIds" array`);
    }
    for (const id of item.goldChunkIds) {
      if (typeof id !== "string" || id.trim() === "") {
        throw new TypeError(`query at index ${position} has a non-string gold chunk id`);
      }
    }
    const sessionId = item.sessionId ?? null;
    if (sessionId !== null && typeof sessionId !== "string") {
      throw new TypeError(`query at index ${position} has a non-string "sessionId"`);
    }
    return {
      id: item.id ?? null,
      query: item.query,
      goldChunkIds: [...item.goldChunkIds],
      sessionId,
    };
  });
}

function normalizeRoutes(routes) {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new TypeError(`routes must be a non-empty array; expected ${ROUTES.join(", ")}`);
  }
  const selected = [];
  for (const route of routes) {
    if (!ROUTE_SET.has(route)) {
      throw new TypeError(`unknown evaluation route "${route}"; expected one of ${ROUTES.join(", ")}`);
    }
    if (!selected.includes(route)) selected.push(route);
  }
  return selected;
}

function corpusSizeOf(index) {
  if (typeof index.size === "number") return index.size;
  if (typeof index.allChunks === "function") return index.allChunks().length;
  return 0;
}

function cutoff(k) {
  if (!Number.isInteger(k) || k <= 0) {
    throw new TypeError(`k must be a positive integer, got ${String(k)}`);
  }
  return k;
}

function uniqueIds(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids ?? []) {
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function readQueries(filePath) {
  const text = readFileSync(filePath, "utf8");
  const queries = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`${filePath}:${index + 1} is not valid JSON (${error.message})`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`${filePath}:${index + 1} must be a JSON object`);
    }
    if (typeof parsed.query !== "string" || parsed.query.trim() === "") {
      throw new Error(`${filePath}:${index + 1} is missing a non-empty "query"`);
    }
    if (!Array.isArray(parsed.goldChunkIds) || parsed.goldChunkIds.length === 0) {
      throw new Error(`${filePath}:${index + 1} is missing a non-empty "goldChunkIds" array`);
    }
    queries.push({
      id: typeof parsed.id === "string" ? parsed.id : null,
      query: parsed.query,
      goldChunkIds: parsed.goldChunkIds.map((id) => String(id)),
      sessionId: parsed.sessionId ?? null,
    });
  });
  return queries;
}

/** Corpus files, sorted, as POSIX paths relative to the corpus directory. */
function listCorpusFiles(corpusDir) {
  const files = [];
  const walk = (absoluteDir, prefix) => {
    const entries = readdirSync(absoluteDir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(absoluteDir, entry.name), relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  };
  walk(corpusDir, "");
  return files;
}

/**
 * Split one fixture file into chunk blocks.
 *
 * Blank lines separate blocks and a lone markdown heading is dropped: a heading
 * is a title, not retrievable content, and keeping it would put the file name in
 * the index twice over the paragraph that actually answers the query.
 */
function splitBlocks(text) {
  const blocks = [];
  for (const raw of String(text).replace(/\r\n/g, "\n").split(/\n\s*\n+/)) {
    const block = raw.trim();
    if (block === "") continue;
    if (isHeadingOnly(block)) continue;
    blocks.push(block);
  }
  return blocks;
}

function isHeadingOnly(block) {
  const lines = block.split("\n").filter((line) => line.trim() !== "");
  return lines.length === 1 && /^#{1,6}\s/.test(lines[0]);
}

function extensionOf(relativePath) {
  const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

function isAbsolutePath(value) {
  return typeof value === "string" && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value));
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

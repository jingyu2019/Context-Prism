// Hybrid retrieval: BM25 relevance + semantic similarity + recency + source priority + user priority.

import { SourceKind, RetrievedItem, isVisibleInScope } from "./models.js";
import { cosineSimilarity, embedText } from "./embedding.js";

const DEFAULT_SOURCE_WEIGHTS = {
  [SourceKind.PREFERENCE]: 1.5,
  [SourceKind.TRAJECTORY]: 1.1,
  [SourceKind.HISTORY]: 1.0,
  [SourceKind.CODE]: 1.0,
  [SourceKind.FILE]: 0.9,
};

/**
 * Headroom for a scoped search.
 *
 * The backend ranks the whole index, so a session whose own history never
 * reaches the global top-K would see an empty history section even though its
 * chunks exist. Asking for a bounded multiple of topK first and filtering
 * afterwards keeps the session's own material reachable. Bounded (4x topK, at
 * most +200 candidates) so the extra cost stays predictable.
 */
const OVERFETCH_FACTOR = 4;
const OVERFETCH_MAX_EXTRA = 200;

const embeddingCache = new Map();

/**
 * Normalize a session scope.
 *
 * `null` / `undefined` / a blank string mean "no scope" (whole index). Anything
 * else must be a string; refusing other types keeps a caller from silently
 * passing a value that could never compare equal to a chunk's owner.
 *
 * @param {unknown} scope
 * @returns {string|null}
 * @throws {TypeError} when scope is neither null/undefined nor a string
 */
export function normalizeScope(scope) {
  if (scope === null || scope === undefined) return null;
  if (typeof scope !== "string") {
    throw new TypeError(`scope must be a string or null, got ${typeof scope}`);
  }
  const trimmed = scope.trim();
  return trimmed === "" ? null : trimmed;
}

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
    scope = null,
  } = {}) {
    this.relevanceWeight = relevanceWeight;
    this.semanticWeight = semanticWeight;
    this.recencyWeight = recencyWeight;
    this.sourceWeight = sourceWeight;
    this.priorityWeight = priorityWeight;
    this.recencyHalfLifeDays = recencyHalfLifeDays;
    this.topK = topK;
    this.sourceWeights = { ...DEFAULT_SOURCE_WEIGHTS, ...sourceWeights };
    this.useSemantic = useSemantic;
    // The session whose history/trajectory may be retrieved: null = whole index.
    this.scope = normalizeScope(scope);
  }
}

/**
 * Score one chunk with the shared hybrid formula.
 *
 * `retrieve()` and the preference lane both go through this, so there is one
 * formula and one set of weights — a preference can never be scored by a rule
 * that ordinary chunks do not see.
 *
 * @param {object} input
 * @param {import("./models.js").Chunk} input.chunk
 * @param {number} [input.rawScore=0] backend relevance, same units as searchWithScores()
 * @param {Float64Array|null} [input.queryVector=null] precomputed query embedding
 * @param {RetrievalConfig|null} [input.config=null]
 * @param {number|null} [input.now=null] epoch seconds; one value per assembly keeps scoring deterministic
 * @returns {{score: number, reason: string}}
 */
export function scoreChunk({ chunk, rawScore = 0, queryVector = null, config = null, now = null }) {
  const cfg = config || new RetrievalConfig();
  const at = Number.isFinite(now) ? now : Date.now() / 1000;
  const relevance = normalizeHitScore(rawScore);

  let score = cfg.relevanceWeight * relevance;
  let semantic = 0;
  if (queryVector && cfg.useSemantic) {
    semantic = cosineSimilarity(queryVector, chunkEmbedding(chunk));
    score += cfg.semanticWeight * semantic;
  }

  const ageDays = Math.max(0, (at - (chunk.timestamp || at)) / 86400);
  const recency = Math.exp(-ageDays / cfg.recencyHalfLifeDays);
  const sourceBoost = cfg.sourceWeights[chunk.kind] ?? 1.0;
  score += cfg.recencyWeight * recency;
  score += cfg.sourceWeight * (sourceBoost - 1.0);
  score += cfg.priorityWeight * ((chunk.priority || 0) / 10.0);

  const reasons = [`bm25=${formatRelevance(relevance)}`];
  if (semantic > 0) reasons.push(`sem=${semantic.toFixed(3)}`);
  if (recency > 0.8) reasons.push("recent");
  if (chunk.priority > 0) reasons.push(`priority=${chunk.priority}`);

  return { score, reason: reasons.join(", ") };
}

export function retrieve(index, query, config = null) {
  const cfg = config || new RetrievalConfig();
  const now = Date.now() / 1000;
  // Each hit carries the score its own backend computed; a backend without a
  // scored search falls back to positional scoring.
  const candidateK = cfg.scope === null
    ? cfg.topK
    : Math.min(cfg.topK * OVERFETCH_FACTOR, cfg.topK + OVERFETCH_MAX_EXTRA);
  const hits = index.searchWithScores ? index.searchWithScores(query, candidateK) : toScoredHits(index.search(query, candidateK));
  const queryVector = cfg.useSemantic ? embedText(query) : null;
  const items = [];
  for (const hit of hits) {
    // The isolation choke point: a chunk owned by another session never reaches
    // scoring, ranking, compression, the caches or the window.
    if (!isVisibleInScope(hit.chunk, cfg.scope)) continue;
    const { score, reason } = scoreChunk({ chunk: hit.chunk, rawScore: hit.score, queryVector, config: cfg, now });
    items.push(new RetrievedItem({ chunk: hit.chunk, score, reason }));
  }
  // Score order, then chunk id: the two backends return candidates in different
  // scan order, and an explicit tie-break is what makes their results comparable.
  items.sort((a, b) => b.score - a.score || String(a.chunk.id).localeCompare(String(b.chunk.id)));
  return items.slice(0, cfg.topK);
}

/**
 * Render a relevance for the human-readable reason string.
 *
 * Three decimals is the right resolution for ranking, but it must never turn a
 * real match into "0.000": a near-tie FTS5 rank (2.9e-6) is a non-zero match,
 * and the reason string is what an operator reads when a hit looks odd.
 */
function formatRelevance(value) {
  if (!Number.isFinite(value) || value === 0) return "0.000";
  if (value < 0.001) return value.toExponential(2);
  return value.toFixed(3);
}

function chunkEmbedding(chunk) {
  if (!embeddingCache.has(chunk.id)) {
    embeddingCache.set(chunk.id, embedText(chunk.content));
  }
  return embeddingCache.get(chunk.id);
}

/** Wrap bare chunks as positional hits for an index without a scored search. */
function toScoredHits(chunks) {
  return chunks.map((chunk, position) => ({ chunk, score: chunks.length === 0 ? 0 : 1 - position / chunks.length }));
}

/**
 * Fold one backend's raw score into [0, 1).
 *
 * The two backends report relevance in different units and different
 * magnitudes, but both are unbounded and both are monotone in "better":
 *
 *   - in-memory BM25: positive, typically 0..15
 *   - SQLite FTS5 `rank`: negative, where more negative is better; measured
 *     over the whole bench fixture it spans -2.9e-6 (near-tie) to -28.8
 *     (strong hit) — seven orders of magnitude, not the -1e-6 band this used
 *     to assume
 *
 * So the map is one saturating curve on the magnitude, with no per-backend
 * constant and no clamp:
 *
 *   x / (x + 1)     |score| 0 -> 0, 1 -> 0.5, 9 -> 0.9, 28.8 -> 0.966,
 *                   finite scores never reach 1
 *
 * Strictly increasing, so two distinct backend scores can never collapse onto
 * the same relevance. The previous `Math.min(0.999, |rank| * 1e6 / (…))`
 * assumed FTS5 ranks were O(1e-6); real ranks are O(1e-6 .. 30), so 407 of 410
 * sqlite hits were mapped to exactly 0.999, relevance became a constant, and
 * the ordering the backend got right was thrown away (sqlite bm25-only fell to
 * R@10 0.463 against LocalIndex's 0.976). A single curve over |score| serves
 * both regimes: near-ties stay strictly ordered at the bottom of the range,
 * strong hits spread across the top, and nothing piles up at a ceiling.
 *
 * The positive branch is byte-for-byte the same as before, so LocalIndex
 * scores do not move.
 */
export function normalizeHitScore(score) {
  if (!Number.isFinite(score)) return 0;
  const magnitude = Math.abs(score);
  return magnitude / (magnitude + 1);
}

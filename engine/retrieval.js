// Hybrid retrieval: BM25 relevance + semantic similarity + recency + source priority + user priority.

import { SourceKind, RetrievedItem } from "./models.js";
import { cosineSimilarity, embedText } from "./embedding.js";

const DEFAULT_SOURCE_WEIGHTS = {
  [SourceKind.PREFERENCE]: 1.5,
  [SourceKind.TRAJECTORY]: 1.1,
  [SourceKind.HISTORY]: 1.0,
  [SourceKind.CODE]: 1.0,
  [SourceKind.FILE]: 0.9,
};

const embeddingCache = new Map();

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
  }
}

export function retrieve(index, query, config = null) {
  const cfg = config || new RetrievalConfig();
  const now = Date.now() / 1000;
  // Each hit carries the score its own backend computed; a backend without a
  // scored search falls back to positional scoring.
  const hits = index.searchWithScores ? index.searchWithScores(query, cfg.topK) : toScoredHits(index.search(query, cfg.topK));
  const queryVector = cfg.useSemantic ? embedText(query) : null;
  const items = [];
  for (const hit of hits) {
    const chunk = hit.chunk;
    let score = cfg.relevanceWeight * normalizeHitScore(hit.score);
    let semantic = 0;
    if (queryVector) {
      semantic = cosineSimilarity(queryVector, chunkEmbedding(chunk));
      score += cfg.semanticWeight * semantic;
    }
    const ageDays = Math.max(0, (now - (chunk.timestamp || now)) / 86400);
    const recency = Math.exp(-ageDays / cfg.recencyHalfLifeDays);
    const sourceBoost = cfg.sourceWeights[chunk.kind] ?? 1.0;
    score += cfg.recencyWeight * recency;
    score += cfg.sourceWeight * (sourceBoost - 1.0);
    score += cfg.priorityWeight * (chunk.priority / 10.0);
    const reasons = [`bm25=${normalizeHitScore(hit.score).toFixed(3)}`];
    if (semantic > 0) reasons.push(`sem=${semantic.toFixed(3)}`);
    if (recency > 0.8) reasons.push("recent");
    if (chunk.priority > 0) reasons.push(`priority=${chunk.priority}`);
    items.push(new RetrievedItem({ chunk, score, reason: reasons.join(", ") }));
  }
  items.sort((a, b) => b.score - a.score);
  return items;
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
 * Fold one backend's raw score into 0..1.
 *
 * The two backends report relevance in different units and wildly different
 * magnitudes:
 *
 *   - in-memory BM25: positive, unbounded, typically 0..15
 *   - SQLite FTS5 `rank`: negative and *tiny* - `-2.4e-6` for a perfect hit,
 *     because FTS5 divides by corpus-level statistics
 *
 * Neither magnitude means anything across backends, so each is mapped through
 * its own scale; within one backend the mapping is monotone, which is all the
 * ranking consumes.
 *
 *   relevance > 0: s / (s + 1)          BM25 0 -> 0, 1 -> 0.5, 9 -> 0.9
 *   relevance < 0: k|s| / (k|s| + 1)    FTS5 with k spreading the -1e-6 band
 */
const FTS_RANK_SCALE = 1e6;

export function normalizeHitScore(score) {
  if (!Number.isFinite(score)) return 0;
  if (score < 0) {
    const spread = Math.abs(score) * FTS_RANK_SCALE;
    return Math.min(0.999, spread / (spread + 1));
  }
  return score / (score + 1);
}

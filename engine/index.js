// In-memory BM25 index (JS port of local_context_engine.index.LocalIndex).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Chunk, SourceKind } from "./models.js";
import { termFrequencies, tokenize } from "./text_utils.js";

export class LocalIndex {
  constructor() {
    this._chunks = new Map();
    this._postings = new Map();
    this._docLengths = new Map();
    this._avgdl = 0;
    this._k1 = 1.5;
    this._b = 0.75;
    this._revision = 0;
  }

  get revision() {
    return this._revision;
  }

  add(chunk) {
    if (this._chunks.has(chunk.id)) this.remove(chunk.id);
    this._chunks.set(chunk.id, chunk);
    const freqs = termFrequencies(tokenize(chunk.content));
    const docLen = Object.values(freqs).reduce((sum, v) => sum + v, 0);
    this._docLengths.set(chunk.id, docLen);
    for (const [token, count] of Object.entries(freqs)) {
      if (!this._postings.has(token)) this._postings.set(token, new Map());
      this._postings.get(token).set(chunk.id, count);
    }
    this._recomputeAvgdl();
    this._revision += 1;
  }

  addMany(chunks) {
    let count = 0;
    for (const chunk of chunks) {
      this.add(chunk);
      count += 1;
    }
    return count;
  }

  remove(chunkId) {
    if (!this._chunks.has(chunkId)) return;
    this._chunks.delete(chunkId);
    this._docLengths.delete(chunkId);
    for (const postings of this._postings.values()) {
      postings.delete(chunkId);
    }
    for (const [token, postings] of this._postings) {
      if (postings.size === 0) this._postings.delete(token);
    }
    this._recomputeAvgdl();
    this._revision += 1;
  }

  clear() {
    this._chunks.clear();
    this._postings.clear();
    this._docLengths.clear();
    this._avgdl = 0;
    this._revision += 1;
  }

  get size() {
    return this._chunks.size;
  }

  get(chunkId) {
    return this._chunks.get(chunkId);
  }

  allChunks() {
    return Array.from(this._chunks.values());
  }

  /**
   * Chunks of one kind, optionally limited to one source.
   *
   * With a `source` filter the newest row comes first, so "the latest chunk of
   * this session" is one cheap read instead of a full scan-and-sort.
   */
  chunksByKind(kind, { source = null, limit = null } = {}) {
    let chunks = this.allChunks().filter((chunk) => chunk.kind === kind && (source === null || chunk.source === source));
    if (source !== null) chunks = chunks.slice().reverse();
    if (Number.isInteger(limit) && limit > 0) chunks = chunks.slice(0, limit);
    return chunks;
  }

  /**
   * BM25 search returning each hit's own score.
   * @returns {{chunk: Chunk, score: number}[]} ordered best first.
   */
  searchWithScores(query, topK = 20) {
    return this._score(query, topK).map(({ chunk, score }) => ({ chunk, score }));
  }

  search(query, topK = 20) {
    return this._score(query, topK).map((hit) => hit.chunk);
  }

  _score(query, topK = 20) {
    if (this._chunks.size === 0) return [];
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];
    const scores = new Map();
    const n = this._chunks.size;
    for (const token of new Set(queryTokens)) {
      const postings = this._postings.get(token);
      if (!postings) continue;
      const df = postings.size;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (const [docId, freq] of postings) {
        const docLen = this._docLengths.get(docId) || 0;
        const denom = freq + this._k1 * (1 - this._b + (this._b * docLen) / Math.max(this._avgdl, 1));
        const score = (idf * (freq * (this._k1 + 1))) / Math.max(denom, 1e-9);
        scores.set(docId, (scores.get(docId) || 0) + score);
      }
    }
    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([docId, score]) => ({ chunk: this._chunks.get(docId), score }));
  }

  save(path) {
    mkdirSync(dirname(path), { recursive: true });
    const payload = {
      version: 1,
      savedAt: Date.now() / 1000,
      chunks: this.allChunks().map((chunk) => ({
        id: chunk.id,
        source: chunk.source,
        kind: chunk.kind,
        content: chunk.content,
        metadata: chunk.metadata,
        timestamp: chunk.timestamp,
        priority: chunk.priority,
        tokens: chunk.tokens,
      })),
    };
    writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
  }

  static load(path) {
    const data = JSON.parse(readFileSync(path, "utf8"));
    const index = new LocalIndex();
    for (const item of data.chunks || []) {
      index.add(
        new Chunk({
          id: item.id,
          source: item.source,
          kind: SourceKind[Object.keys(SourceKind).find((key) => SourceKind[key] === item.kind)] || item.kind,
          content: item.content,
          metadata: item.metadata || {},
          timestamp: item.timestamp,
          priority: item.priority || 0,
          tokens: item.tokens || 0,
        }),
      );
    }
    return index;
  }

  _recomputeAvgdl() {
    if (this._docLengths.size === 0) {
      this._avgdl = 0;
      return;
    }
    let total = 0;
    for (const len of this._docLengths.values()) total += len;
    this._avgdl = total / this._docLengths.size;
  }
}

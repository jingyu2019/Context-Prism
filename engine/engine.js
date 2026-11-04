// The Local Context Engine orchestrator (JS port).

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

import { TTLCache } from "./cache.js";
import { buildOmittedNote, compressItems, compressItemsAsync, packedTokens } from "./compression.js";
import { LocalIndex } from "./index.js";
import { SqliteIndex } from "./sqlite_index.js";
import {
  chunkText,
  ingestDirectory,
  ingestFile,
  ingestHistoryJsonl,
  ingestTrajectoryJsonl,
} from "./ingest.js";
import { Chunk, ContextSection, ContextWindow, RetrievedItem, SourceKind, estimateTokens } from "./models.js";
import { readSessionEvents, sessionIdOf, describeEvent } from "./session_events.js";
import { PriorityConfig, prioritize } from "./prioritization.js";
import { RetrievalConfig, retrieve } from "./retrieval.js";

const DEFAULT_DIRECTORY_EXTENSIONS = [".py", ".ts", ".tsx", ".js", ".jsx", ".md", ".txt", ".json", ".jsonl", ".csv", ".html", ".css"];

export class LocalContextEngine {
  constructor({ index = null, storagePath = null, backend = "auto", cacheSize = 128, cacheTtl = 60 } = {}) {
    this.storagePath = storagePath ? String(storagePath) : null;
    this.retrievalCache = new TTLCache({ maxsize: cacheSize, ttlSeconds: cacheTtl });
    this.compressionCache = new TTLCache({ maxsize: cacheSize, ttlSeconds: cacheTtl });
    if (index) {
      this.index = index;
    } else if (this.storagePath) {
      this.index = this._openIndex(this.storagePath, backend);
    } else if (backend === "sqlite") {
      this.index = new SqliteIndex(":memory:");
    } else {
      this.index = new LocalIndex();
    }
  }

  // ------------------------------------------------------------------
  // Ingest API
  // ------------------------------------------------------------------
  addChunk(chunk) {
    this.index.add(chunk);
  }

  addChunks(chunks) {
    return this.index.addMany(chunks);
  }

  addText({ content, source, kind, chunkSize = 800, overlap = 80, metadata = {}, timestamp = null, priority = 0 }) {
    const chunks = chunkText({ content, source, kind, chunkSize, overlap, metadata, timestamp, priority });
    return this.addChunks(chunks);
  }

  addFile(filePath, kind = null) {
    return this.addChunks(ingestFile(filePath, kind));
  }

  addDirectory(directory, { kind = null, extensions = null, ignore = [] } = {}) {
    return this.addChunks(ingestDirectory(directory, { kind, extensions, ignore }));
  }

  addHistoryJsonl(filePath, sourceName = null) {
    return this.addChunks(ingestHistoryJsonl(filePath, sourceName));
  }

  addTrajectoryJsonl(filePath, sourceName = null) {
    return this.addChunks(ingestTrajectoryJsonl(filePath, sourceName));
  }

  addFileIncremental({ path, kind = null, statePath = null } = {}) {
    const stateFile = statePath ? String(statePath) : this._defaultStatePath();
    const state = this._loadState(stateFile);
    const key = resolve(path);
    const stat = statSync(path);
    const previous = state[key];
    if (previous && previous.mtime === stat.mtimeMs && previous.size === stat.size) {
      return { added: 0, changed: 0, skipped: 1 };
    }
    const count = this.addFile(path, kind);
    state[key] = { mtime: stat.mtimeMs, size: stat.size };
    this._saveState(stateFile, state);
    return { added: count, changed: count > 0 ? 1 : 0, skipped: 0 };
  }

  addDirectoryIncremental({ directory, kind = null, extensions = null, ignore = [], statePath = null } = {}) {
    const stateFile = statePath ? String(statePath) : this._defaultStatePath();
    const state = this._loadState(stateFile);
    const allowed = new Set(extensions || DEFAULT_DIRECTORY_EXTENSIONS);
    const ignored = new Set(ignore || []);
    let totalAdded = 0;
    let totalChanged = 0;
    let totalSkipped = 0;
    const currentKeys = new Set();

    const walk = (dir) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (ignored.size > 0 && full.split(/[\\/]/).some((part) => ignored.has(part))) continue;
        if (allowed.size > 0 && !allowed.has(extname(full).toLowerCase())) continue;
        const key = resolve(full);
        currentKeys.add(key);
        const stat = statSync(full);
        const previous = state[key];
        if (previous && previous.mtime === stat.mtimeMs && previous.size === stat.size) {
          totalSkipped += 1;
          continue;
        }
        try {
          const count = this.addFile(full, kind);
          state[key] = { mtime: stat.mtimeMs, size: stat.size };
          totalAdded += count;
          totalChanged += count > 0 ? 1 : 0;
        } catch {
          // skip unreadable file
        }
      }
    };
    walk(directory);

    for (const key of Object.keys(state)) {
      if (!currentKeys.has(key) && !existsSync(key)) delete state[key];
    }
    this._saveState(stateFile, state);
    return { added: totalAdded, changed: totalChanged, skipped: totalSkipped };
  }

  /**
   * Capture one session's model-visible events into the index.
   *
   * The cursor lives in the index (kind `session_cursor`, keyed by session id),
   * so capture survives a host restart and is shared by every engine instance
   * that opens the same index. Re-capturing is idempotent: chunk ids are
   * derived from (session, type, seq).
   *
   * @param {{session: object, cursor: number, limit: number}} options
   * @returns {{added: number, newUserMessages: number, cursor: number, total: number, skipped: number}}
   */
  captureSessionEvents({ session, cursor = 0, limit = 400 } = {}) {
    const sessionId = sessionIdOf(session);
    if (!sessionId) return { added: 0, newUserMessages: 0, cursor, total: 0, skipped: 0 };
    const { events, total } = readSessionEvents(session, { fromSeq: cursor });
    // Keep the hot path bounded: capture at most `limit` new events per call and
    // let the next step pick up the remainder.
    const batch = events.slice(0, limit);
    const chunks = [];
    let newUserMessages = 0;
    let nextCursor = cursor;
    for (const event of batch) {
      nextCursor = Math.max(nextCursor, Number(event.seq) || 0);
      const projected = describeEvent(event, sessionId);
      if (!projected) continue;
      if (projected.kind === SourceKind.HISTORY && projected.author === "user") newUserMessages += 1;
      chunks.push(
        new Chunk({
          id: projected.id,
          source: `session:${sessionId}`,
          kind: projected.kind,
          content: projected.content,
          metadata: { sessionId, seq: event.seq, eventType: event.type },
          timestamp: event.time ? event.time / 1000 : Date.now() / 1000,
          priority: projected.priority,
        }),
      );
    }
    if (chunks.length > 0) this.index.addMany(chunks);
    if (nextCursor !== cursor) this._writeSessionCursor(sessionId, nextCursor);
    return {
      added: chunks.length,
      newUserMessages,
      cursor: nextCursor,
      total,
      skipped: Math.max(0, events.length - batch.length),
    };
  }

  /** Read the persisted capture cursor for one session. */
  sessionCursor(sessionId) {
    const chunk = this.index.get(cursorId(sessionId));
    return chunk ? Number(chunk.metadata?.seq) || 0 : 0;
  }

  /** Look up this engine's most recent session chunk, for inject-time dedupe. */
  lastSessionChunk(sessionId) {
    return this.index.chunksByKind(SourceKind.HISTORY, { source: `session:${sessionId}`, limit: 1 })[0] || null;
  }

  _writeSessionCursor(sessionId, seq) {
    this.index.add(
      new Chunk({
        id: cursorId(sessionId),
        source: `session:${sessionId}`,
        kind: SourceKind.SESSION_CURSOR,
        content: String(seq),
        metadata: { sessionId, seq },
        timestamp: Date.now() / 1000,
      }),
    );
  }

  clearCaches() {
    this.retrievalCache.clear();
    this.compressionCache.clear();
  }

  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------
  save(path = null) {
    const target = path ? String(path) : this.storagePath;
    if (!target) throw new Error("No storage path configured; pass one to save().");
    this.index.save(target);
  }

  load(path = null, backend = "auto") {
    const target = path ? String(path) : this.storagePath;
    if (!target) throw new Error("No storage path configured; pass one to load().");
    this.index = this._openIndex(target, backend);
    this.storagePath = target;
  }

  // ------------------------------------------------------------------
  // Context building
  // ------------------------------------------------------------------
  buildContext({ query, maxTokens = 8000, reservedOutputTokens = 1024, retrievalConfig = null, priorityConfig = null, includePreferences = true } = {}) {
    const budget = Math.max(0, maxTokens - reservedOutputTokens);
    if (budget <= 0) throw new Error("maxTokens must be greater than reservedOutputTokens");

    const retrievalKey = this._retrievalCacheKey(query, retrievalConfig);
    let retrieved = this.retrievalCache.get(retrievalKey);
    if (!retrieved) {
      retrieved = retrieve(this.index, query, retrievalConfig);
      this.retrievalCache.set(retrievalKey, retrieved);
    }
    const prioritized = prioritize(retrieved, priorityConfig);

    let prefSection = null;
    let omittedCount = 0;
    let omittedTokens = 0;
    if (includePreferences) {
      const prefChunks = this.index.chunksByKind(SourceKind.PREFERENCE);
      if (prefChunks.length > 0) {
        const prefItems = prefChunks.map((chunk, i) => new RetrievedItem({ chunk, score: 10.0 - i * 0.001, reason: "always-include preference" }));
        const prefKey = this._compressionCacheKey(query, budget, prefItems);
        let prefResult = this.compressionCache.get(prefKey);
        if (!prefResult) {
          prefResult = compressItems(prefItems, budget, query);
          this.compressionCache.set(prefKey, prefResult);
        }
        prefSection = this._sectionFromResult("User Preferences", prefResult);
        omittedCount += prefResult.omittedCount;
        omittedTokens += prefResult.omittedTokens;
      }
    }

    const used = prefSection ? prefSection.tokens : 0;
    const remaining = Math.max(0, budget - used);
    const nonPrefItems = prioritized.filter((item) => item.chunk.kind !== SourceKind.PREFERENCE);
    const nonPrefKey = this._compressionCacheKey(query, remaining, nonPrefItems);
    let nonPrefResult = this.compressionCache.get(nonPrefKey);
    if (!nonPrefResult) {
      nonPrefResult = compressItems(nonPrefItems, remaining, query);
      this.compressionCache.set(nonPrefKey, nonPrefResult);
    }
    omittedCount += nonPrefResult.omittedCount;
    omittedTokens += nonPrefResult.omittedTokens;

    const sections = [];
    if (prefSection) sections.push(prefSection);
    sections.push(...this._groupIntoSections(nonPrefResult));

    const note = buildOmittedNote(omittedCount, omittedTokens);
    if (note) {
      const noteTokens = estimateTokens(note);
      const usedAfterSections = sections.reduce((sum, section) => sum + section.tokens, 0);
      if (usedAfterSections + noteTokens <= budget) {
        sections.push(new ContextSection({ title: "Omitted Memory", content: note, tokens: noteTokens, compressed: true }));
      }
    }

    const totalTokens = sections.reduce((sum, section) => sum + section.tokens, 0);
    return new ContextWindow({
      query,
      sections,
      maxTokens,
      reservedOutputTokens,
      tokenBudget: budget,
      totalTokens,
      omittedCount,
      omittedTokens,
    });
  }

  async buildContextAsync({
    query,
    maxTokens = 8000,
    reservedOutputTokens = 1024,
    retrievalConfig = null,
    priorityConfig = null,
    includePreferences = true,
    summarizer = null,
  } = {}) {
    const budget = Math.max(0, maxTokens - reservedOutputTokens);
    if (budget <= 0) throw new Error("maxTokens must be greater than reservedOutputTokens");

    const retrievalKey = this._retrievalCacheKey(query, retrievalConfig);
    let retrieved = this.retrievalCache.get(retrievalKey);
    if (!retrieved) {
      retrieved = retrieve(this.index, query, retrievalConfig);
      this.retrievalCache.set(retrievalKey, retrieved);
    }
    const prioritized = prioritize(retrieved, priorityConfig);

    let prefSection = null;
    let omittedCount = 0;
    let omittedTokens = 0;
    if (includePreferences) {
      const prefChunks = this.index.chunksByKind(SourceKind.PREFERENCE);
      if (prefChunks.length > 0) {
        const prefItems = prefChunks.map((chunk, i) => new RetrievedItem({ chunk, score: 10.0 - i * 0.001, reason: "always-include preference" }));
        const prefKey = this._compressionCacheKey(query, budget, prefItems);
        let prefResult = this.compressionCache.get(prefKey);
        if (!prefResult) {
          prefResult = await compressItemsAsync(prefItems, budget, query, { summarizer });
          this.compressionCache.set(prefKey, prefResult);
        }
        prefSection = this._sectionFromResult("User Preferences", prefResult);
        omittedCount += prefResult.omittedCount;
        omittedTokens += prefResult.omittedTokens;
      }
    }

    const used = prefSection ? prefSection.tokens : 0;
    const remaining = Math.max(0, budget - used);
    const nonPrefItems = prioritized.filter((item) => item.chunk.kind !== SourceKind.PREFERENCE);
    const nonPrefKey = this._compressionCacheKey(query, remaining, nonPrefItems);
    let nonPrefResult = this.compressionCache.get(nonPrefKey);
    if (!nonPrefResult) {
      nonPrefResult = await compressItemsAsync(nonPrefItems, remaining, query, { summarizer });
      this.compressionCache.set(nonPrefKey, nonPrefResult);
    }
    omittedCount += nonPrefResult.omittedCount;
    omittedTokens += nonPrefResult.omittedTokens;

    const sections = [];
    if (prefSection) sections.push(prefSection);
    sections.push(...this._groupIntoSections(nonPrefResult));

    const note = buildOmittedNote(omittedCount, omittedTokens);
    if (note) {
      const noteTokens = estimateTokens(note);
      const usedAfterSections = sections.reduce((sum, section) => sum + section.tokens, 0);
      if (usedAfterSections + noteTokens <= budget) {
        sections.push(new ContextSection({ title: "Omitted Memory", content: note, tokens: noteTokens, compressed: true }));
      }
    }

    const totalTokens = sections.reduce((sum, section) => sum + section.tokens, 0);
    return new ContextWindow({
      query,
      sections,
      maxTokens,
      reservedOutputTokens,
      tokenBudget: budget,
      totalTokens,
      omittedCount,
      omittedTokens,
    });
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------
  _retrievalCacheKey(query, config) {
    return ["retrieve", this.index.revision, String(query).trim().toLowerCase(), this._retrievalConfigFingerprint(config)];
  }

  _retrievalConfigFingerprint(config) {
    if (!config) return null;
    return [
      config.relevanceWeight,
      config.recencyWeight,
      config.sourceWeight,
      config.priorityWeight,
      config.recencyHalfLifeDays,
      config.topK,
      Object.entries(config.sourceWeights).sort(([a], [b]) => a.localeCompare(b)),
    ];
  }

  _compressionCacheKey(query, budget, items) {
    const itemSig = items.map((item) => [item.chunk.id, Math.round(item.score * 1e6) / 1e6]);
    return ["compress", this.index.revision, String(query).trim().toLowerCase(), budget, itemSig];
  }

  _sectionFromResult(title, result) {
    const content = this._renderPacked(result.packed);
    // Report the rendered cost, separators included: this number feeds the
    // budget check for the Omitted Memory note, so understating it lets the
    // window overshoot the budget it just enforced.
    const tokens = result.packed.reduce((sum, packed) => sum + packed.tokens, 0) + packedTokens(result.packed.length);
    return new ContextSection({
      title,
      content,
      tokens,
      items: result.packed.map((packed) => packed.item),
      compressed: result.packed.some((packed) => packed.compressed),
    });
  }

  _groupIntoSections(result) {
    const titles = {
      [SourceKind.HISTORY]: "Relevant History",
      [SourceKind.TRAJECTORY]: "Agent Trajectory",
      [SourceKind.CODE]: "Relevant Code",
      [SourceKind.FILE]: "Relevant Files",
    };
    const grouped = new Map(Object.keys(titles).map((kind) => [kind, []]));
    for (const packed of result.packed) {
      const kind = packed.item.chunk.kind;
      if (grouped.has(kind)) grouped.get(kind).push(packed);
    }
    const sections = [];
    for (const [kind, packedList] of grouped) {
      if (packedList.length === 0) continue;
      const content = this._renderPacked(packedList);
      const tokens = packedList.reduce((sum, packed) => sum + packed.tokens, 0) + packedTokens(packedList.length);
      sections.push(
        new ContextSection({
          title: titles[kind],
          content,
          tokens,
          items: packedList.map((packed) => packed.item),
          compressed: packedList.some((packed) => packed.compressed),
        }),
      );
    }
    return sections;
  }

  _renderPacked(packedList) {
    return packedList
      .map((packed) => {
        const chunk = packed.item.chunk;
        const sourceLabel = chunk.metadata?.path || chunk.source;
        return `[${chunk.kind} | ${sourceLabel}]\n${packed.content}`;
      })
      .join("\n\n");
  }

  _openIndex(path, backend) {
    if (backend === "sqlite") return new SqliteIndex(path);
    if (backend === "json") return existsSync(path) ? LocalIndex.load(path) : new LocalIndex();
    if (existsSync(path)) {
      if (/\.(db|sqlite|sqlite3)$/i.test(path) || looksLikeSqlite(path)) return new SqliteIndex(path);
      return LocalIndex.load(path);
    }
    if (/\.(db|sqlite|sqlite3)$/i.test(path)) return new SqliteIndex(path);
    return new LocalIndex();
  }

  _defaultStatePath() {
    if (this.storagePath) return `${this.storagePath}.state.json`;
    return ".lce_incremental_state.json";
  }

  _loadState(path) {
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return {};
    }
  }

  _saveState(path, state) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
  }
}

function looksLikeSqlite(path) {
  try {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(16);
      readSync(fd, buffer, 0, 16, 0);
      return buffer.toString("latin1") === "SQLite format 3\u0000";
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Stable chunk id for one session's capture cursor. */
function cursorId(sessionId) {
  return `session_cursor:${sessionId}`;
}

// The Local Context Engine orchestrator (JS port).

import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { TTLCache } from "./cache.js";
import { buildOmittedNote, compressItems, compressItemsAsync, packedTokens } from "./compression.js";
import { LocalIndex } from "./index.js";
import { SqliteIndex } from "./sqlite_index.js";
import {
  chunkText,
  ingestDirectory,
  ingestDirectoryIncremental,
  ingestFile,
  ingestHistoryJsonl,
  ingestTrajectoryJsonl,
} from "./ingest.js";
import { Chunk, ContextSection, ContextWindow, RetrievedItem, SourceKind, estimateTokens } from "./models.js";
import { readSessionEvents, sessionIdOf, describeEvent } from "./session_events.js";
import { PriorityConfig, prioritize } from "./prioritization.js";
import { RetrievalConfig, normalizeScope, retrieve, scoreChunk } from "./retrieval.js";
import { embedText } from "./embedding.js";

export class LocalContextEngine {
  constructor({ index = null, storagePath = null, backend = "auto", cacheSize = 128, cacheTtl = 60 } = {}) {
    this.storagePath = storagePath ? String(storagePath) : null;
    this.retrievalCache = new TTLCache({ maxsize: cacheSize, ttlSeconds: cacheTtl });
    this.compressionCache = new TTLCache({ maxsize: cacheSize, ttlSeconds: cacheTtl });
    // Per-session capture guard. Instance state, never module state: two engines
    // (two indexes) never contend, and dropping the engine drops the guard.
    this._captureInFlight = new Map();
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

  /**
   * Index a directory incrementally, delegating the walk to `ingest.js`.
   *
   * The walk owns the bounds (size cap, volume cap, `.lceignore`, symlink
   * policy) and returns the complete next state; this method owns persistence
   * and the index write. `added`/`changed`/`skipped` keep their old meaning and
   * `sizeSkipped`/`symlinkSkipped` surface what the bounds rejected.
   *
   * @returns {{added: number, changed: number, skipped: number, sizeSkipped: number, symlinkSkipped: number}}
   */
  addDirectoryIncremental({ directory, kind = null, extensions = null, ignore = [], statePath = null, maxFileBytes = null } = {}) {
    const stateFile = statePath ? String(statePath) : this._defaultStatePath();
    const state = this._loadState(stateFile);
    const { chunks, state: nextState, stats } = ingestDirectoryIncremental({
      directory,
      state,
      kind,
      extensions,
      ignore,
      maxFileBytes,
    });
    if (chunks.length > 0) this.addChunks(chunks);
    // `nextState` covers every file this walk visited, so deleted files are
    // already absent: persist it verbatim, never merge with the old map.
    this._saveState(stateFile, nextState);
    return {
      added: stats.added,
      changed: stats.changed,
      skipped: stats.skipped,
      sizeSkipped: stats.sizeSkipped,
      symlinkSkipped: stats.symlinkSkipped,
    };
  }

  /**
   * Capture one session's model-visible events into the index.
   *
   * The cursor lives in the index (kind `session_cursor`, keyed by session id),
   * so capture survives a host restart and is shared by every engine instance
   * that opens the same index. Re-capturing is idempotent: chunk ids are
   * derived from (session, type, seq) and inserts are upserts.
   *
   * Re-entrancy: one capture per session at a time. A second call for a session
   * whose capture is still in flight is coalesced into a no-op (`reentered:
   * true`) instead of re-reading and re-writing the same events; the in-flight
   * call owns both the write and the accounting. Different sessions never
   * contend — the guard is keyed by session id and holds no global lock.
   *
   * @param {{session: object, cursor?: number, limit?: number}} options
   * @returns {{added: number, newUserMessages: number, cursor: number, total: number, skipped: number, reentered: boolean}}
   */
  captureSessionEvents({ session, cursor = 0, limit = 400 } = {}) {
    const sessionId = sessionIdOf(session);
    if (!sessionId) return { added: 0, newUserMessages: 0, cursor, total: 0, skipped: 0, reentered: false };
    if (this._captureInFlight.has(sessionId)) {
      return {
        added: 0,
        newUserMessages: 0,
        cursor: this.sessionCursor(sessionId),
        total: 0,
        skipped: 0,
        reentered: true,
      };
    }
    this._captureInFlight.set(sessionId, true);
    try {
      // The persisted cursor is authoritative and EXCLUSIVE: it names the last
      // seq already captured, so reading restarts after it. The cursor chunk's
      // presence — not its value — distinguishes "nothing captured yet" from
      // "captured up to seq 0" (seq 0 is a legal event number, and the cursor
      // value 0 is also what an empty cursor reads as).
      //
      // Inclusive reading here was a defect: a no-op assembly re-read the event
      // at seq === persisted, re-upserted its chunk, overcounted `added` and
      // bumped index.revision, which invalidated every rev-keyed cache entry on
      // every turn.
      const cursorChunk = this.index.get(cursorId(sessionId));
      const persisted = cursorChunk ? Number(cursorChunk.metadata?.seq) || 0 : 0;
      const callerCursor = Number(cursor) || 0;
      const fromSeq = Math.max(callerCursor, cursorChunk ? persisted + 1 : 0);
      const { events, total } = readSessionEvents(session, { fromSeq });
      // Keep the hot path bounded: capture at most `limit` new events per call and
      // let the next step pick up the remainder.
      const batch = events.slice(0, limit);
      const chunks = [];
      let newUserMessages = 0;
      let nextCursor = fromSeq;
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
      // Monotone write, and only when this read actually moved forward (or when
      // this is the first capture, which creates the cursor even at seq 0). A
      // caller that passes a cursor ahead of the session must not be able to
      // skip events by having that number persisted. A no-op capture writes
      // nothing, so index.revision — and every cache key derived from it — is
      // untouched.
      if (events.length > 0 && (!cursorChunk || nextCursor > persisted)) {
        this._writeSessionCursor(sessionId, nextCursor);
      }
      return {
        added: chunks.length,
        newUserMessages,
        cursor: nextCursor,
        total,
        skipped: Math.max(0, events.length - batch.length),
        reentered: false,
      };
    } finally {
      this._captureInFlight.delete(sessionId);
    }
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
  buildContext(options = {}) {
    const {
      query,
      maxTokens = 8000,
      reservedOutputTokens = 1024,
      retrievalConfig = null,
      priorityConfig = null,
      includePreferences = true,
      scope = null,
      presence = null,
      dedupeAgainstPrompt = true,
      // Off by default: the counterfactual is a DIAGNOSTIC number, not part of
      // assembling a window. Turning it on is an explicit opt-in by the few
      // paths that display it (the build tool), so the per-step hot path never
      // pays a second assembly for a number only a human reads.
      measureSavings = false,
    } = options;
    const budget = Math.max(0, maxTokens - reservedOutputTokens);
    if (budget <= 0) throw new Error("maxTokens must be greater than reservedOutputTokens");

    const effectiveScope = resolveScope(scope, retrievalConfig);
    const config = this._retrievalConfig(effectiveScope, retrievalConfig);

    const retrievalKey = this._retrievalCacheKey(query, config, effectiveScope);
    let retrieved = this.retrievalCache.get(retrievalKey);
    if (!retrieved) {
      retrieved = retrieve(this.index, query, config);
      this.retrievalCache.set(retrievalKey, retrieved);
    }
    const prioritized = prioritize(retrieved, priorityConfig);
    // One predicate, two outcomes, applied BEFORE anything is compressed or
    // budgeted: text the live request already carries is duplication and goes;
    // text it does not carry is project material or history compaction removed,
    // and leaving it in the pool is exactly what gets it injected — with the
    // budget the duplicate would have spent.
    const presenceFilter = this._presenceFilter(presence, dedupeAgainstPrompt);

    let prefSection = null;
    let omittedCount = 0;
    let omittedTokens = 0;
    if (includePreferences) {
      const prefItems = this._preferenceItems(query, config).filter((item) => presenceFilter.keep(item));
      if (prefItems.length > 0) {
        const prefKey = this._compressionCacheKey(query, budget, prefItems, effectiveScope);
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
    const nonPrefItems = prioritized
      .filter((item) => item.chunk.kind !== SourceKind.PREFERENCE)
      .filter((item) => presenceFilter.keep(item));
    const nonPrefKey = this._compressionCacheKey(query, remaining, nonPrefItems, effectiveScope);
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
    const window = new ContextWindow({
      query,
      sections,
      maxTokens,
      reservedOutputTokens,
      tokenBudget: budget,
      totalTokens,
      omittedCount,
      omittedTokens,
      scope: effectiveScope,
    });
    return withDedupeReport(window, {
      droppedCount: presenceFilter.count,
      candidateTokens: presenceFilter.tokens,
      savedTokens: this._savedTokens(options, window, presenceFilter, measureSavings),
    });
  }

  async buildContextAsync(options = {}) {
    const {
      query,
      maxTokens = 8000,
      reservedOutputTokens = 1024,
      retrievalConfig = null,
      priorityConfig = null,
      includePreferences = true,
      summarizer = null,
      scope = null,
      presence = null,
      dedupeAgainstPrompt = true,
      // Off by default: the counterfactual is a DIAGNOSTIC number, not part of
      // assembling a window. Turning it on is an explicit opt-in by the few
      // paths that display it (the build tool), so the per-step hot path never
      // pays a second assembly for a number only a human reads.
      measureSavings = false,
    } = options;
    const budget = Math.max(0, maxTokens - reservedOutputTokens);
    if (budget <= 0) throw new Error("maxTokens must be greater than reservedOutputTokens");

    const effectiveScope = resolveScope(scope, retrievalConfig);
    const config = this._retrievalConfig(effectiveScope, retrievalConfig);

    const retrievalKey = this._retrievalCacheKey(query, config, effectiveScope);
    let retrieved = this.retrievalCache.get(retrievalKey);
    if (!retrieved) {
      retrieved = retrieve(this.index, query, config);
      this.retrievalCache.set(retrievalKey, retrieved);
    }
    const prioritized = prioritize(retrieved, priorityConfig);
    // Same predicate as the sync path, and deliberately the same position:
    // before compression, so a dropped duplicate hands its budget to whatever
    // survives instead of shrinking the window.
    const presenceFilter = this._presenceFilter(presence, dedupeAgainstPrompt);

    let prefSection = null;
    let omittedCount = 0;
    let omittedTokens = 0;
    if (includePreferences) {
      const prefItems = this._preferenceItems(query, config).filter((item) => presenceFilter.keep(item));
      if (prefItems.length > 0) {
        const prefKey = this._compressionCacheKey(query, budget, prefItems, effectiveScope);
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
    const nonPrefItems = prioritized
      .filter((item) => item.chunk.kind !== SourceKind.PREFERENCE)
      .filter((item) => presenceFilter.keep(item));
    const nonPrefKey = this._compressionCacheKey(query, remaining, nonPrefItems, effectiveScope);
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
    const window = new ContextWindow({
      query,
      sections,
      maxTokens,
      reservedOutputTokens,
      tokenBudget: budget,
      totalTokens,
      omittedCount,
      omittedTokens,
      scope: effectiveScope,
    });
    return withDedupeReport(window, {
      droppedCount: presenceFilter.count,
      candidateTokens: presenceFilter.tokens,
      savedTokens: await this._savedTokensAsync(options, window, presenceFilter, measureSavings),
    });
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------
  /**
   * Which RetrievalConfig an assembly actually uses.
   *
   * The scope has to live on the config, because `retrieve()` reads it from
   * there: one place decides what is visible, not two.
   */
  _retrievalConfig(scope, retrievalConfig) {
    if (!retrievalConfig) return new RetrievalConfig({ scope });
    return new RetrievalConfig({ ...retrievalConfig, scope });
  }

  /**
   * The presence predicate for one assembly.
   *
   * A retrieved chunk whose text the live request already carries is
   * duplication and is dropped; a chunk whose text it does NOT carry is kept,
   * because that is either project material the model has not read or history a
   * compaction `replace` removed — the second half of what this feature must
   * preserve, and why this is not "history off by default".
   *
   * Inactive (every item kept, zero drops) when there is no presence index, when
   * the caller passed one without a `contains` method, or when
   * `dedupeAgainstPrompt` is false. Those paths must be byte-for-byte the old
   * behaviour.
   *
   * @param {{contains: (text: unknown) => boolean}|null} presence
   * @param {boolean} enabled
   * @returns {{active: boolean, keep: (item: object) => boolean, count: number, tokens: number}}
   */
  _presenceFilter(presence, enabled) {
    const active = enabled !== false && presence != null && typeof presence.contains === "function";
    // Mutated by `keep`, read only after filtering: a counter, not control flow.
    const stats = { count: 0, tokens: 0 };
    return {
      keep(item) {
        if (!active) return true;
        const content = item?.chunk?.content;
        if (!presence.contains(content)) return true;
        stats.count += 1;
        stats.tokens += item.chunk.tokens || estimateTokens(content);
        return false;
      },
      get active() {
        return active;
      },
      get count() {
        return stats.count;
      },
      get tokens() {
        return stats.tokens;
      },
    };
  }

  /**
   * Tokens this assembly actually avoided injecting.
   *
   * The candidate-pool total is NOT a saving. An item dropped from an over-full
   * pool may never have been packed anyway, so counting it overstates the win —
   * a measured session showed a 59,178-token pool against a 31,458-token
   * realised delta, a ~1.9x false claim. The only honest figure is the
   * counterfactual: assemble the same window WITHOUT the filter and diff the
   * material the two windows carry.
   *
   * Two hard constraints on that counterfactual:
   *
   *   1. It NEVER reaches an LLM. `summarizer: null` is forced (and
   *      `measureSavings: false` stops recursion), so the control uses
   *      extractive compression only. A feature built to save tokens must not
   *      spend model calls to report how many it saved.
   *   2. It is OFF by default (`measureSavings` defaults to false). Only the
   *      diagnostic paths that actually display `dupSavedTokens` opt in, so the
   *      per-step prompt assembly never pays for a second full assembly unless
   *      asked.
   *
   * @param {object} options - the original buildContext options.
   * @param {object} window - the filtered window.
   * @param {{active: boolean, count: number}} presenceFilter
   * @param {boolean} measureSavings - explicit opt-in; false disables measurement.
   * @returns {number} realised saving in report item-token units, never negative.
   */
  _savedTokens(options, window, presenceFilter, measureSavings) {
    if (!measureSavings || !presenceFilter.active || presenceFilter.count === 0) return 0;
    const control = this.buildContext({
      ...options,
      presence: null,
      dedupeAgainstPrompt: false,
      measureSavings: false,
      // Material accounting needs packed material, never a summarized render.
      summarizer: null,
    });
    return Math.max(0, materialTokens(control) - materialTokens(window));
  }

  /** Async twin of {@link _savedTokens}; same counterfactual, same units, no LLM. */
  async _savedTokensAsync(options, window, presenceFilter, measureSavings) {
    if (!measureSavings || !presenceFilter.active || presenceFilter.count === 0) return 0;
    const control = await this.buildContextAsync({
      ...options,
      presence: null,
      dedupeAgainstPrompt: false,
      measureSavings: false,
      // Force extractive compression: measurement must never call a model.
      summarizer: null,
    });
    return Math.max(0, materialTokens(control) - materialTokens(window));
  }

  /**
   * Preferences are always included, but their order follows the query.
   *
   * The old `10.0 - i * 0.001` ladder scored a preference by its storage
   * position, so the section came out identical for every query. Now they go
   * through the same formula as everything else — backend relevance, then the
   * shared weights — and every preference is still included; a chunk with no
   * overlap simply sorts last.
   *
   * @returns {RetrievedItem[]} every PREFERENCE chunk, score desc, tie-break id asc
   */
  _preferenceItems(query, config) {
    const chunks = this.index.chunksByKind(SourceKind.PREFERENCE);
    if (chunks.length === 0) return [];
    const rawScores = new Map();
    if (typeof this.index.searchWithScores === "function") {
      const hits = this.index.searchWithScores(query, Math.max(chunks.length, 20));
      for (const hit of hits) rawScores.set(hit.chunk.id, hit.score);
    }
    const now = Date.now() / 1000;
    const queryVector = config.useSemantic ? embedText(query ?? "") : null;
    const items = chunks.map((chunk) => {
      const { score, reason } = scoreChunk({
        chunk,
        rawScore: rawScores.get(chunk.id) ?? 0,
        queryVector,
        config,
        now,
      });
      return new RetrievedItem({ chunk, score, reason: `always-include; ${reason}` });
    });
    items.sort((a, b) => b.score - a.score || String(a.chunk.id).localeCompare(String(b.chunk.id)));
    return items;
  }

  /**
   * Cache key for one retrieval — a STRING.
   *
   * The cache is a Map, and object keys compare by identity: the old array key
   * meant every lookup missed, so the caches never served anything. Making the
   * key a string is what activates them, which is exactly why the scope has to
   * be in it on the same change — otherwise session B is handed A's window.
   *
   * `JSON.stringify(scope)` renders null as `s:null` and a session as
   * `s:"sess-1"`, so no real session id can collide with the unscoped value.
   */
  _retrievalCacheKey(query, config, scope) {
    return `v1|retrieve|rev:${this.index.revision}|s:${JSON.stringify(scope)}|q:${normalizeQuery(query)}|cfg:${JSON.stringify(configFingerprint(config))}`;
  }

  /**
   * Cache key for one compression.
   *
   * Scope *and* the item signature: the signature pins the payload, the scope
   * pins the policy, so a change in either can never reuse a foreign result.
   */
  _compressionCacheKey(query, budget, items, scope) {
    const signature = createHash("sha1")
      .update(JSON.stringify(items.map((item) => [item.chunk.id, Math.round(item.score * 1e6) / 1e6])))
      .digest("hex");
    return `v1|compress|rev:${this.index.revision}|s:${JSON.stringify(scope)}|q:${normalizeQuery(query)}|b:${budget}|items:${signature}`;
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

/**
 * Reconcile the explicit `scope` option with `retrievalConfig.scope`.
 *
 * Precedence: the argument wins, the config is the fallback. Two non-null values
 * that disagree throw instead of silently picking one — a wrong scope is a leak,
 * not a preference.
 */
function resolveScope(explicitScope, retrievalConfig) {
  const fromArgument = normalizeScope(explicitScope);
  const fromConfig = retrievalConfig ? normalizeScope(retrievalConfig.scope) : null;
  if (fromArgument !== null && fromConfig !== null && fromArgument !== fromConfig) {
    throw new TypeError(`conflicting session scope: argument "${fromArgument}" vs retrievalConfig "${fromConfig}"`);
  }
  return fromArgument ?? fromConfig;
}

/** Canonical query text for cache keys: whitespace-normalized, lowercased. */
function normalizeQuery(query) {
  return String(query ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Expose the dedupe accounting on the window it produced.
 *
 * Four numbers, deliberately named so none can be quoted as another:
 *
 *   - `dupDroppedCount` — how many retrieved chunks the predicate removed.
 *   - `dupCandidateTokens` — the candidate pool those chunks were worth. An
 *     UPPER BOUND: a chunk dropped from an over-full pool may never have been
 *     packed, so this is not a saving and must never be quoted as one (a
 *     measured session: pool 59,178 vs realised 31,458, ~1.9x too high).
 *   - `dupSavedTokens` — the realised saving: tokens the rendered window does
 *     NOT carry that the unfiltered window would have, in the same item-token
 *     units the report uses. THIS is the only number that may be called a
 *     saving.
 *   - `dupDroppedTokens` — LEGACY ALIAS of `dupCandidateTokens` (the pool).
 *     Retained only because `test/dedupe_falsification.test.js` pins it at
 *     step 1 of its measurement; it carries NO saving semantics. New code must
 *     read `dupSavedTokens` for savings and `dupCandidateTokens` for the pool,
 *     and the shipping diagnostics in `lib/index.js` publish only those two.
 *
 * They live on the window instance (and on its report) rather than in
 * `models.js`, which owns the stable ContextWindow shape and is not part of
 * this change.
 *
 * @param {object} window - freshly built ContextWindow.
 * @param {{droppedCount?: number, candidateTokens?: number, savedTokens?: number}} [accounting]
 * @returns {object} the same window.
 */
function withDedupeReport(window, { droppedCount = 0, candidateTokens = 0, savedTokens = 0 } = {}) {
  const fields = {
    dupDroppedCount: droppedCount,
    dupCandidateTokens: candidateTokens,
    dupSavedTokens: savedTokens,
    dupDroppedTokens: candidateTokens,
  };
  Object.assign(window, fields);
  const report = window.report.bind(window);
  window.report = () => ({ ...report(), ...fields });
  return window;
}

/**
 * Tokens of the material a window carries, in report item-token units.
 *
 * Same convention as `ContextWindow.report()` per-item `tokens` (and as the
 * independent verification harness): the advisory "Omitted Memory" note is not
 * injected material and is excluded. Used to diff a filtered window against its
 * counterfactual.
 *
 * @param {object} window - a ContextWindow.
 * @returns {number}
 */
function materialTokens(window) {
  let total = 0;
  for (const section of window.sections ?? []) {
    if (section.title === "Omitted Memory") continue;
    for (const item of section.items ?? []) {
      const chunk = item.chunk;
      total += chunk.tokens > 0 ? chunk.tokens : estimateTokens(chunk.content);
    }
  }
  return total;
}

/**
 * Everything that changes a ranking, in a fixed order.
 *
 * `semanticWeight` and `useSemantic` belong here because they change the score:
 * without them a `bm25-only` request could be served a cached `hybrid` result,
 * which is exactly the comparison the evaluator exists to make.
 */
function configFingerprint(config) {
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

// SQLite FTS5 index for the Local Context Engine (JS port).
// Uses Node's built-in `node:sqlite` (available in Node 22.5+; tested on Node 24/26).
//
// v0.9 changes (docs/SPEC-SESSION-ISOLATION.md §4.5, §4.6.1; defects D9, D10):
//   - FTS5 indexes a `search_text` shadow column fed by `tokenize()`, so the
//     SQLite backend answers the same CJK bigram queries as `LocalIndex`.
//     FTS5's own `unicode61` tokenizer treats a whole CJK run as ONE token, so
//     indexing raw `content` would return zero hits for every bigram query.
//   - A MATCH that returns zero rows is a normal "no match": it returns []
//     and never triggers the LIKE scan.
//   - The LIKE scan runs only when FTS5 is genuinely unusable, is capped, and
//     increments counters exposed through `index.diagnostics`.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Chunk, SourceKind } from "./models.js";
import { tokenize } from "./text_utils.js";

/** Rows the capped LIKE scan may look at, newest first. */
export const LIKE_SCAN_ROW_CAP = 5000;
/** Rows the capped LIKE scan may return, whatever `topK` asks for. */
export const LIKE_MAX_RESULTS = 50;

const SEARCH_TEXT_VERSION = "1";
const SEARCH_TEXT_BATCH = 500;
const FTS_PROBE_QUERY = '"__lce_fts_probe__"';
const CJK_RE = /[\u4e00-\u9fff]/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chunks (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    search_text TEXT,
    metadata TEXT NOT NULL,
    timestamp REAL,
    priority REAL,
    tokens INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    search_text,
    content='chunks',
    content_rowid='rowid',
    tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, search_text)
    VALUES ('delete', old.rowid, old.search_text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, search_text)
    VALUES ('delete', old.rowid, old.search_text);
    INSERT INTO chunks_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

/**
 * The value stored in `chunks.search_text`.
 *
 * ASCII-only content is stored verbatim, so ASCII behaviour (and FTS ranking)
 * is byte-for-byte what it was; only rows that actually contain CJK pay the
 * ~2x bigram expansion.
 */
function searchTextFor(content) {
  const text = typeof content === "string" ? content : String(content ?? "");
  if (!CJK_RE.test(text)) return text;
  return tokenize(text).join(" ");
}

function normalizeLimit(topK) {
  if (Number.isInteger(topK) && topK >= 0) return topK;
  return 20;
}

export class SqliteIndex {
  /**
   * @param {string} dbPath  `:memory:` or a file path.
   * @param {{forceFtsUnavailable?: boolean}} [options]
   *   `forceFtsUnavailable` is a diagnostics/testing seam that makes the index
   *   behave as if FTS5 were not compiled in, so the capped LIKE fallback can
   *   be exercised on a machine that does have FTS5.
   */
  constructor(dbPath = ":memory:", { forceFtsUnavailable = false } = {}) {
    this.dbPath = String(dbPath);
    if (this.dbPath !== ":memory:") {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this._diag = {
      ftsErrorCount: 0,
      likeFallbackCount: 0,
      likeFallbackRows: 0,
      lastFallbackAt: null,
      searchTextMigration: "ok",
    };
    this._likeScanRowCap = LIKE_SCAN_ROW_CAP;
    this.db.exec(SCHEMA);
    this._migrateSearchText();
    this._ftsAvailable = forceFtsUnavailable ? false : this._detectFts();
    this._revision = this._loadRevision();
  }

  get revision() {
    return this._revision;
  }

  /**
   * Read-only search diagnostics (spec §4.5). Same shape as `LocalIndex`.
   */
  get diagnostics() {
    return {
      ftsErrorCount: this._diag.ftsErrorCount,
      likeFallbackCount: this._diag.likeFallbackCount,
      likeFallbackRows: this._diag.likeFallbackRows,
      lastFallbackAt: this._diag.lastFallbackAt,
      searchTextMigration: this._diag.searchTextMigration,
    };
  }

  close() {
    this.db.close();
  }

  add(chunk) {
    this._add(chunk);
  }

  addMany(chunks) {
    let count = 0;
    for (const chunk of chunks) {
      this._add(chunk);
      count += 1;
    }
    return count;
  }

  remove(chunkId) {
    const result = this.db.prepare("DELETE FROM chunks WHERE id = ?").run(chunkId);
    if (Number(result.changes) > 0) this._bumpRevision();
  }

  clear() {
    this.db.exec("DELETE FROM chunks");
    this._bumpRevision();
  }

  get size() {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get().n);
  }

  get(chunkId) {
    const row = this.db.prepare("SELECT * FROM chunks WHERE id = ?").get(chunkId);
    return row ? this._rowToChunk(row) : undefined;
  }

  allChunks() {
    return this.db.prepare("SELECT * FROM chunks ORDER BY rowid").all().map((row) => this._rowToChunk(row));
  }

  /**
   * Chunks of one kind, optionally limited to one source.
   *
   * With a `source` filter the newest row comes first, so "the latest chunk of
   * this session" is one indexed read instead of a full scan-and-sort.
   */
  chunksByKind(kind, { source = null, limit = null } = {}) {
    const limitClause = Number.isInteger(limit) && limit > 0 ? " LIMIT ?" : "";
    const order = source !== null ? " ORDER BY rowid DESC" : " ORDER BY rowid";
    const statement = this.db.prepare(`SELECT * FROM chunks WHERE kind = ?${source !== null ? " AND source = ?" : ""}${order}${limitClause}`);
    const params = source !== null ? [kind, source] : [kind];
    if (limitClause) params.push(limit);
    return statement.all(...params).map((row) => this._rowToChunk(row));
  }

  /**
   * FTS5 search returning each hit's own `rank`.
   * @returns {{chunk: Chunk, score: number}[]} ordered best first (rank ascending).
   */
  searchWithScores(query, topK = 20) {
    const limit = normalizeLimit(topK);
    const rows = this._matchRows(query, limit);
    if (rows !== null) {
      return rows.map((row) => ({ chunk: this._rowToChunk(row), score: Number(row.fts_rank) || 0 }));
    }
    const chunks = this._likeSearch(query, limit);
    return chunks.map((chunk, position) => ({ chunk, score: chunks.length === 0 ? 0 : 1 - position / chunks.length }));
  }

  search(query, topK = 20) {
    const limit = normalizeLimit(topK);
    const rows = this._matchRows(query, limit);
    if (rows !== null) return rows.map((row) => this._rowToChunk(row));
    return this._likeSearch(query, limit);
  }

  save(path = null) {
    if (path !== null && String(path) !== this.dbPath) {
      throw new Error("SqliteIndex is bound to its dbPath; use a new instance to copy.");
    }
    // DatabaseSync autocommits by default.
  }

  static load(path) {
    return new SqliteIndex(path);
  }

  /**
   * One FTS5 MATCH attempt.
   *
   * @returns {object[] | null} matching rows, or `null` when the MATCH threw
   *   (FTS5 unusable for this database); an empty array is a genuine no-match.
   */
  _matchRows(query, limit) {
    const ftsQuery = this._buildFtsQuery(query);
    if (!ftsQuery) return [];
    if (!this._ftsAvailable) return null;
    const first = this._tryMatch(ftsQuery, limit);
    if (first !== null) return first;
    const sanitized = this._sanitizeFtsQuery(query);
    if (sanitized && sanitized !== ftsQuery) {
      const second = this._tryMatch(sanitized, limit);
      if (second !== null) return second;
    }
    // Two failures: treat FTS5 as genuinely unavailable and remember it, so the
    // capped LIKE path runs at most for the rest of this index's life.
    this._ftsAvailable = false;
    return null;
  }

  _tryMatch(ftsQuery, limit) {
    try {
      return this.db
        .prepare(
          `SELECT c.*, f.rank AS fts_rank
           FROM chunks_fts f
           JOIN chunks c ON c.rowid = f.rowid
           WHERE chunks_fts MATCH ?
           ORDER BY f.rank
           LIMIT ?`,
        )
        .all(ftsQuery, limit);
    } catch {
      this._diag.ftsErrorCount += 1;
      return null;
    }
  }

  /**
   * Capped full-table fallback: newest `LIKE_SCAN_ROW_CAP` rows only, at most
   * `min(topK, LIKE_MAX_RESULTS)` results. Counters make it observable.
   */
  _likeSearch(query, limit) {
    const capped = Math.max(0, Math.min(limit, LIKE_MAX_RESULTS));
    const escaped = String(query ?? "").replace(/[\\%_]/g, (character) => `\\${character}`);
    const pattern = `%${escaped}%`;
    this._diag.likeFallbackCount += 1;
    this._diag.lastFallbackAt = Date.now();
    try {
      if (capped === 0) return [];
      const rows = this.db
        .prepare(
          `SELECT * FROM (
             SELECT rowid, id, source, kind, content, metadata, timestamp, priority, tokens
             FROM chunks ORDER BY rowid DESC LIMIT ?
           )
           WHERE content LIKE ? ESCAPE '\\'
           ORDER BY rowid LIMIT ?`,
        )
        .all(this._likeScanRowCap, pattern, capped);
      this._diag.likeFallbackRows += rows.length;
      return rows.map((row) => this._rowToChunk(row));
    } catch {
      return [];
    }
  }

  _add(chunk) {
    this.db
      .prepare(
        `INSERT INTO chunks (id, source, kind, content, search_text, metadata, timestamp, priority, tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            source = excluded.source,
            kind = excluded.kind,
            content = excluded.content,
            search_text = excluded.search_text,
            metadata = excluded.metadata,
            timestamp = excluded.timestamp,
            priority = excluded.priority,
            tokens = excluded.tokens`,
      )
      .run(
        chunk.id,
        chunk.source,
        chunk.kind,
        chunk.content,
        searchTextFor(chunk.content),
        JSON.stringify(chunk.metadata || {}),
        chunk.timestamp,
        chunk.priority,
        chunk.tokens,
      );
    this._bumpRevision();
  }

  _bumpRevision() {
    this._revision += 1;
    this.db
      .prepare(
        `INSERT INTO meta(key, value) VALUES('revision', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(this._revision));
  }

  _loadRevision() {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'revision'").get();
    return row ? Number(row.value) : 0;
  }

  _buildFtsQuery(query) {
    const tokens = tokenize(query);
    if (tokens.length === 0) return null;
    return tokens.map((token) => `"${token}"`).join(" OR ");
  }

  /**
   * Conservative rebuild of the MATCH expression from the same tokens.
   * Tokens are already `[a-z0-9_]` or CJK bigrams, so this is normally
   * identical to `_buildFtsQuery`; it exists so a future tokenizer change
   * cannot inject FTS5 operators into a retry.
   */
  _sanitizeFtsQuery(query) {
    const tokens = tokenize(query).filter((token) => /^[a-z0-9_\u4e00-\u9fff]+$/.test(token));
    if (tokens.length === 0) return null;
    return tokens.map((token) => `"${token}"`).join(" OR ");
  }

  /**
   * Probe FTS5 once at open and cache the answer.
   *
   * `CREATE VIRTUAL TABLE ... fts5` in `SCHEMA` already fails loudly on a build
   * without FTS5, so a failed probe really means "the module is unusable for
   * this database" (corrupt/locked shadow table, partial migration, ...).
   */
  _detectFts() {
    try {
      this.db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT 0").all(FTS_PROBE_QUERY);
      return true;
    } catch {
      this._diag.ftsErrorCount += 1;
      return false;
    }
  }

  /**
   * Idempotent, one-pass migration of a pre-v0.9 database (spec §4.6.1).
   *
   * Chunk rows are never dropped: only `search_text` is added and backfilled,
   * and only the FTS shadow table + its three triggers are rebuilt. A failure
   * is recorded in `diagnostics.searchTextMigration` ("failed") and the index
   * keeps working on the capped LIKE path instead of pretending to be fine.
   */
  _migrateSearchText() {
    try {
      const recorded = this.db.prepare("SELECT value FROM meta WHERE key = 'search_text_version'").get();
      if (recorded && String(recorded.value) === SEARCH_TEXT_VERSION) {
        this._diag.searchTextMigration = "ok";
        return;
      }
      const columns = this.db.prepare("PRAGMA table_info(chunks)").all().map((row) => String(row.name));
      if (!columns.includes("search_text")) {
        this.db.exec("ALTER TABLE chunks ADD COLUMN search_text TEXT");
      }
      // Drop the shadow index and its triggers *before* backfilling so no
      // trigger fires 0..N times per backfilled row.
      this.db.exec(`
        DROP TRIGGER IF EXISTS chunks_ai;
        DROP TRIGGER IF EXISTS chunks_ad;
        DROP TRIGGER IF EXISTS chunks_au;
        DROP TABLE IF EXISTS chunks_fts;
      `);
      this._backfillSearchText();
      this._rebuildFts();
      this.db
        .prepare(
          `INSERT INTO meta(key, value) VALUES('search_text_version', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(SEARCH_TEXT_VERSION);
      this._diag.searchTextMigration = "ok";
    } catch (error) {
      this._diag.searchTextMigration = "failed";
      try {
        console.warn(`[context-prism] search_text migration failed; falling back to capped LIKE scan: ${error?.message || error}`);
      } catch {
        // console may be unavailable; the diagnostic flag is the contract.
      }
    }
  }

  _backfillSearchText() {
    const select = this.db.prepare("SELECT rowid, content FROM chunks WHERE search_text IS NULL LIMIT ?");
    const update = this.db.prepare("UPDATE chunks SET search_text = ? WHERE rowid = ?");
    for (;;) {
      const rows = select.all(SEARCH_TEXT_BATCH);
      if (rows.length === 0) return;
      this.db.exec("BEGIN");
      try {
        for (const row of rows) update.run(searchTextFor(row.content), row.rowid);
        this.db.exec("COMMIT");
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // ignore rollback failure; the original error is what matters
        }
        throw error;
      }
    }
  }

  _rebuildFts() {
    this.db.exec(`
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        search_text,
        content='chunks',
        content_rowid='rowid',
        tokenize = 'unicode61'
      );
      CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
      END;
      CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, search_text)
        VALUES ('delete', old.rowid, old.search_text);
      END;
      CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, search_text)
        VALUES ('delete', old.rowid, old.search_text);
        INSERT INTO chunks_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
      END;
      INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');
    `);
  }

  _rowToChunk(row) {
    return new Chunk({
      id: row.id,
      source: row.source,
      kind: row.kind,
      content: row.content,
      metadata: JSON.parse(row.metadata || "{}"),
      timestamp: row.timestamp,
      priority: row.priority || 0,
      tokens: row.tokens || 0,
    });
  }
}

// SQLite FTS5 index for the Local Context Engine (JS port).
// Uses Node's built-in `node:sqlite` (available in Node 22.5+; tested on Node 24).

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Chunk, SourceKind } from "./models.js";
import { tokenize } from "./text_utils.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chunks (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT NOT NULL,
    timestamp REAL,
    priority REAL,
    tokens INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content,
    content='chunks',
    content_rowid='rowid',
    tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
    INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

export class SqliteIndex {
  constructor(dbPath = ":memory:") {
    this.dbPath = String(dbPath);
    if (this.dbPath !== ":memory:") {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec(SCHEMA);
    this._revision = this._loadRevision();
  }

  get revision() {
    return this._revision;
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
    const ftsQuery = this._buildFtsQuery(query);
    if (ftsQuery) {
      try {
        const rows = this.db
          .prepare(
            `SELECT c.*, f.rank AS fts_rank
             FROM chunks_fts f
             JOIN chunks c ON c.rowid = f.rowid
             WHERE chunks_fts MATCH ?
             ORDER BY f.rank
             LIMIT ?`,
          )
          .all(ftsQuery, topK);
        if (rows.length > 0) return rows.map((row) => ({ chunk: this._rowToChunk(row), score: Number(row.fts_rank) || 0 }));
      } catch {
        // FTS syntax issue -> fall through to the LIKE scan below.
      }
    }
    return this.search(query, topK).map((chunk, position, all) => ({ chunk, score: all.length === 0 ? 0 : 1 - position / all.length }));
  }

  search(query, topK = 20) {
    const ftsQuery = this._buildFtsQuery(query);
    if (ftsQuery) {
      try {
        const rows = this.db
          .prepare(
            `SELECT c.*, f.rank AS fts_rank
             FROM chunks_fts f
             JOIN chunks c ON c.rowid = f.rowid
             WHERE chunks_fts MATCH ?
             ORDER BY f.rank
             LIMIT ?`,
          )
          .all(ftsQuery, topK);
        if (rows.length > 0) return rows.map((row) => this._rowToChunk(row));
      } catch {
        // FTS syntax issue -> fall through to LIKE.
      }
    }
    const pattern = `%${query}%`;
    const rows = this.db
      .prepare("SELECT * FROM chunks WHERE content LIKE ? ESCAPE '\\' ORDER BY rowid LIMIT ?")
      .all(pattern, topK);
    return rows.map((row) => this._rowToChunk(row));
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

  _add(chunk) {
    this.db
      .prepare(
        `INSERT INTO chunks (id, source, kind, content, metadata, timestamp, priority, tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            source = excluded.source,
            kind = excluded.kind,
            content = excluded.content,
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

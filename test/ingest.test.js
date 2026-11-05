// t3 — ingestion bounds, symlink safety, CJK bigrams and the observable LIKE
// fallback (docs/SPEC-SESSION-ISOLATION.md §4.4, §4.5, §4.6.1, D9–D11).
//
// Everything here is asserted through the public surfaces the rest of the
// engine uses: `walkFiles` / `ingestDirectory` / `ingestDirectoryIncremental`,
// `tokenize`, `LocalIndex.search/searchWithScores/chunksByKind` and the same
// three on `SqliteIndex` (including a pre-v0.9 database that must migrate).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { LocalIndex } from "../engine/index.js";
import { SqliteIndex, LIKE_MAX_RESULTS, LIKE_SCAN_ROW_CAP } from "../engine/sqlite_index.js";
import { Chunk, SourceKind, estimateTokens } from "../engine/models.js";
import { tokenize } from "../engine/text_utils.js";
import {
  DEFAULT_IGNORE_FILE,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_TOTAL_BYTES,
  ingestDirectory,
  ingestDirectoryIncremental,
  ingestFile,
  ingestText,
  walkFiles,
} from "../engine/ingest.js";

const CJK_SENTENCE = "我们要讨论上下文窗口的隔离设计和并发装配"; // exactly 20 characters
const CJK_QUERY = "上下文窗"; // 4 characters, contained in the sentence
const CJK_WHOLE_RUN_QUERY = CJK_SENTENCE;

function tempDir(prefix = "lce-ingest-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function write(dir, name, content) {
  const full = join(dir, name);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
  return full;
}

function chunk(content, id, kind = SourceKind.FILE, source = `${id}.md`) {
  return new Chunk({ id, source, kind, content });
}

// ---------------------------------------------------------------------------
// 1. Size bound: maxFileBytes, configurable, default 1 MiB, counted.
// ---------------------------------------------------------------------------

test("directory ingestion skips files above maxFileBytes and counts them", () => {
  assert.equal(DEFAULT_MAX_FILE_BYTES, 1024 * 1024, "default cap is 1 MiB");

  const dir = tempDir();
  write(dir, "small.md", "short note about context");
  write(dir, "big.md", "x".repeat(4096));

  const bounded = walkFiles(dir, { maxFileBytes: 1024 });
  assert.equal(bounded.files.length, 1);
  assert.equal(bounded.files[0].path, resolve(join(dir, "small.md")));
  assert.equal(bounded.stats.sizeSkipped, 1, "one file exceeded the cap");

  const result = ingestDirectoryIncremental({ directory: dir, maxFileBytes: 1024 });
  assert.equal(result.stats.added, 1, "only the small file produced chunks");
  assert.equal(result.stats.changed, 1);
  assert.equal(result.stats.skipped, 0);
  assert.equal(result.stats.sizeSkipped, 1, "sizeSkipped is reported next to added/changed/skipped");
  assert.equal(result.chunks.length, 1);
  assert.match(result.chunks[0].source, /small\.md$/);
  assert.equal(Object.keys(result.state).length, 1, "the skipped file is not part of the state");

  // The same file is ingested once the cap is raised (`added` counts chunks).
  const raised = ingestDirectoryIncremental({ directory: dir, maxFileBytes: 8192 });
  assert.equal(raised.stats.sizeSkipped, 0);
  assert.equal(Object.keys(raised.state).length, 2, "both files are in the state now");
  assert.ok(raised.chunks.length > 1);

  // And the default (1 MiB) is what a caller that passes nothing gets.
  const viaDefault = ingestDirectoryIncremental({ directory: dir });
  assert.equal(viaDefault.stats.sizeSkipped, 0, "4 KiB is well under the 1 MiB default");

  const hugeDir = tempDir();
  write(hugeDir, "ok.md", "fine");
  write(hugeDir, "huge.md", "y".repeat(DEFAULT_MAX_FILE_BYTES + 1));
  const huge = ingestDirectoryIncremental({ directory: hugeDir });
  assert.equal(huge.stats.sizeSkipped, 1, "a file one byte over the default cap is skipped");
  assert.equal(huge.stats.added, 1);
});

// ---------------------------------------------------------------------------
// 2. Symlinks: never followed, loops terminate, nothing outside the root.
// ---------------------------------------------------------------------------

test("the directory walk never follows symlinks, so a symlink loop terminates", () => {
  const root = tempDir();
  write(root, "a.md", "alpha document");
  write(root, "sub/b.md", "beta document");

  // A directory loop back to the root, and a link to a file outside the root.
  symlinkSync(root, join(root, "loop"), "dir");
  const outside = tempDir("lce-outside-");
  const outsideFile = write(outside, "outside.md", "must never be indexed");
  symlinkSync(outsideFile, join(root, "outside-link.md"));

  const { files, stats } = walkFiles(root);
  assert.equal(files.length, 2, "walk terminates with exactly the two real files");
  assert.deepEqual(files.map((file) => file.path).sort(), [resolve(join(root, "a.md")), resolve(join(root, "sub/b.md"))].sort());
  assert.equal(stats.symlinkSkipped, 2);
  for (const file of files) {
    assert.ok(file.path.startsWith(resolve(root) + sep), `${file.path} is inside the root`);
    assert.ok(!file.path.includes(`${sep}loop${sep}`));
  }

  // Same tree through the ingest API: termination + nothing outside the root.
  const result = ingestDirectoryIncremental({ directory: root });
  assert.equal(result.chunks.length, 2);
  assert.equal(result.stats.symlinkSkipped, 2);
  for (const chunkItem of result.chunks) {
    assert.ok(chunkItem.source.startsWith(resolve(root) + sep), "indexed source stays inside the root");
    assert.ok(!chunkItem.content.includes("must never be indexed"));
  }
  const statePaths = Object.keys(result.state);
  assert.equal(statePaths.length, 2);
  assert.ok(!statePaths.some((key) => key.includes(`${sep}loop`)));

  // A nested loop (sub/up -> root) is skipped too.
  symlinkSync(root, join(root, "sub", "up"), "dir");
  const nested = walkFiles(root);
  assert.equal(nested.files.length, 2);
  assert.equal(nested.stats.symlinkSkipped, 3);
});

test("followSymlinks: true still terminates on a loop (visited realpath set)", () => {
  const root = tempDir();
  write(root, "a.md", "alpha");
  write(root, "real/b.md", "beta");
  symlinkSync(join(root, "real"), join(root, "alias"), "dir");
  symlinkSync(root, join(root, "loop"), "dir");

  const { files, stats } = walkFiles(root, { followSymlinks: true });
  assert.ok(Array.isArray(files), "walk returned instead of looping forever");
  assert.ok(files.length < 50, "bounded even while following links");
  // `real/b.md`, `alias/b.md` and possibly a second view through `loop` — all
  // inside the root, all finite.
  for (const file of files) assert.ok(file.path.startsWith(resolve(root) + sep));
  assert.ok(stats.symlinkSkipped >= 1, "the loop was refused and counted");
});

// ---------------------------------------------------------------------------
// 3. .lceignore at the walked root.
// ---------------------------------------------------------------------------

test(".lceignore at the workspace root is honoured like the built-in ignore list", () => {
  assert.equal(DEFAULT_IGNORE_FILE, ".lceignore");

  const dir = tempDir();
  write(dir, "keep.md", "public notes");
  write(dir, "secret.md", "private notes");
  write(dir, "drafts/wip.md", "unfinished");
  write(dir, "notes.tmp.md", "scratch");
  write(dir, "node_modules/pkg/index.md", "vendored");
  write(
    dir,
    ".lceignore",
    ["# comments and blank lines are skipped", "", "secret.md", "drafts/", "*.tmp.md"].join("\n"),
  );

  const { files, stats } = walkFiles(dir);
  assert.deepEqual(files.map((file) => file.path).sort(), [
    resolve(join(dir, "keep.md")),
    resolve(join(dir, "node_modules/pkg/index.md")),
  ].sort(), ".lceignore rules removed secret.md, drafts/ and *.tmp.md");
  assert.ok(stats.ignored >= 3, `ignored count covers every rule (got ${stats.ignored})`);

  const result = ingestDirectoryIncremental({ directory: dir });
  assert.equal(result.chunks.length, 2, "only the two non-ignored files are indexed");
  assert.ok(result.chunks.some((item) => /public notes/.test(item.content)));
  assert.ok(!result.chunks.some((item) => /private notes|unfinished|scratch/.test(item.content)));
  assert.equal(Object.keys(result.state).length, 2);

  // The built-in `ignore` option still applies on top of the ignore file.
  const both = walkFiles(dir, { ignore: ["node_modules"] });
  assert.deepEqual(both.files.map((file) => file.path), [resolve(join(dir, "keep.md"))]);
  assert.ok(both.stats.ignored >= 4);

  // An ignoreFile name that does not exist is simply no rules.
  const none = walkFiles(dir, { ignoreFile: "missing.ignore" });
  assert.deepEqual(none.files.map((file) => file.path).sort(), [
    resolve(join(dir, "drafts/wip.md")),
    resolve(join(dir, "keep.md")),
    resolve(join(dir, "node_modules/pkg/index.md")),
    resolve(join(dir, "notes.tmp.md")),
    resolve(join(dir, "secret.md")),
  ].sort());
});

// ---------------------------------------------------------------------------
// 4. CJK bigrams: tokenizer + both indexes, including the SQLite shadow column.
// ---------------------------------------------------------------------------

test("tokenize() splits CJK runs into overlapping bigrams and leaves ASCII alone", () => {
  assert.equal(CJK_SENTENCE.length, 20);
  assert.equal(CJK_QUERY.length, 4);

  assert.deepEqual(tokenize(CJK_QUERY), ["上下", "下文", "文窗"]);
  assert.deepEqual(tokenize("你好世界"), ["你好", "好世", "世界"]);
  assert.deepEqual(tokenize("中"), ["中"], "a single-character run stays one token");
  assert.deepEqual(tokenize("中文abc中文"), ["中文", "abc", "中文"], "order follows the text");
  assert.deepEqual(tokenize("上下文窗"), ["上下", "下文", "文窗"]);

  // ASCII tokenization is byte-for-byte unchanged.
  assert.deepEqual(tokenize("The cat sat on the mat."), ["the", "cat", "sat", "on", "the", "mat"]);
  assert.deepEqual(tokenize("compile_to_wasm v2"), ["compile_to_wasm", "v2"]);
  assert.deepEqual(tokenize(""), []);

  // estimateTokens counts characters, not tokens: untouched by the bigrams.
  assert.equal(estimateTokens("你好世界"), 4);
  assert.equal(estimateTokens(""), 0);

  // The query's bigrams are a subset of the sentence's bigrams.
  const sentenceTokens = new Set(tokenize(CJK_SENTENCE));
  for (const bigram of tokenize(CJK_QUERY)) assert.ok(sentenceTokens.has(bigram), `${bigram} is shared`);
});

test("LocalIndex: a 4-character Chinese query retrieves a 20-character sentence", () => {
  const index = new LocalIndex();
  index.addMany([
    chunk(CJK_SENTENCE, "cjk"),
    chunk("The cat sat on the mat.", "ascii"),
    chunk("Python RAG dynamic context window compression.", "rag"),
  ]);

  const hits = index.search(CJK_QUERY, 3);
  assert.equal(hits[0]?.id, "cjk", "sub-string query matches the longer sentence");
  assert.equal(hits.length, 1, "no unrelated chunk is dragged in");

  const whole = index.search(CJK_WHOLE_RUN_QUERY, 3);
  assert.equal(whole[0]?.id, "cjk", "the whole-run query still matches");

  assert.equal(index.search("cat mat", 3)[0]?.id, "ascii", "ASCII retrieval still works");
  assert.deepEqual(index.search("zzzznothing", 3), []);
});

test("SqliteIndex: a 4-character Chinese query retrieves a 20-character sentence", () => {
  const index = new SqliteIndex(":memory:");
  index.addMany([
    chunk(CJK_SENTENCE, "cjk"),
    chunk("The cat sat on the mat.", "ascii"),
    chunk("Python RAG dynamic context window compression.", "rag"),
  ]);

  const hits = index.search(CJK_QUERY, 3);
  assert.equal(hits[0]?.id, "cjk", "bigram query hits through the search_text shadow column");
  assert.equal(hits.length, 1);

  const whole = index.search(CJK_WHOLE_RUN_QUERY, 3);
  assert.equal(whole[0]?.id, "cjk", "the previous whole-run query path still works on SQLite");

  assert.equal(index.search("cat mat", 3)[0]?.id, "ascii", "ASCII retrieval still works");
  assert.deepEqual(index.search("zzzznothing", 3), []);

  // searchWithScores stays consistent with search on the CJK path.
  const scored = index.searchWithScores(CJK_QUERY, 3);
  assert.equal(scored[0]?.chunk.id, "cjk");
  assert.equal(typeof scored[0]?.score, "number");
});

test("a pre-v0.9 SQLite database migrates in place without dropping chunks", () => {
  const dir = tempDir();
  const dbPath = join(dir, "legacy.db");

  // Build the v0.8 schema by hand: FTS5 over `content`, no `search_text`.
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE chunks (
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
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      content, content='chunks', content_rowid='rowid', tokenize='unicode61'
    );
    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content)
      VALUES ('delete', old.rowid, old.content);
    END;
    CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content)
      VALUES ('delete', old.rowid, old.content);
      INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const insert = legacy.prepare(
    "INSERT INTO chunks (id, source, kind, content, metadata, timestamp, priority, tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run("legacy-cjk", "legacy-cjk.md", SourceKind.FILE, CJK_SENTENCE, "{}", null, 0, 8);
  insert.run("legacy-ascii", "legacy-ascii.md", SourceKind.FILE, "Python RAG dynamic context window compression.", "{}", null, 0, 8);
  legacy.exec("INSERT INTO meta(key, value) VALUES('revision', '2')");
  legacy.close();

  const index = new SqliteIndex(dbPath);
  assert.equal(index.size, 2, "no chunk row was dropped by the migration");
  assert.equal(index.diagnostics.searchTextMigration, "ok");
  assert.equal(index.diagnostics.likeFallbackCount, 0, "the migrated index searches with FTS, not LIKE");

  // The CJK claim holds on the migrated database…
  assert.equal(index.search(CJK_QUERY, 3)[0]?.id, "legacy-cjk");
  // …and so does the pre-existing whole-run behaviour…
  assert.equal(index.search(CJK_WHOLE_RUN_QUERY, 3)[0]?.id, "legacy-cjk");
  // …and ASCII is unaffected.
  assert.equal(index.search("dynamic context window", 3)[0]?.id, "legacy-ascii");

  // New rows go through the rebuilt triggers.
  index.add(chunk("新的中文内容关于上下文窗口", "after-migration"));
  assert.equal(index.search("上下文窗", 3)[0]?.id, "after-migration");
  index.remove("after-migration");
  assert.equal(index.size, 2);

  // The state is persisted, so reopening is a no-op that keeps every row.
  const reopened = new SqliteIndex(dbPath);
  assert.equal(reopened.size, 2);
  assert.equal(reopened.search(CJK_QUERY, 3)[0]?.id, "legacy-cjk");
  assert.equal(reopened.diagnostics.searchTextMigration, "ok");
  reopened.close();

  const raw = new DatabaseSync(dbPath);
  const version = raw.prepare("SELECT value FROM meta WHERE key = 'search_text_version'").get();
  assert.equal(String(version?.value), "1", "migration is recorded and therefore idempotent");
  const searchText = raw.prepare("SELECT search_text FROM chunks WHERE id = 'legacy-cjk'").get();
  assert.ok(searchText?.search_text?.includes("上下 下文"), "CJK rows were backfilled with space-separated bigrams");
  const asciiText = raw.prepare("SELECT search_text FROM chunks WHERE id = 'legacy-ascii'").get();
  assert.match(asciiText?.search_text || "", /dynamic context window/, "ASCII rows are stored verbatim");
  raw.close();
  index.close();
});

// ---------------------------------------------------------------------------
// 5. The LIKE fallback: explicit, capped, observable — and not used for a
//    plain zero-row MATCH.
// ---------------------------------------------------------------------------

test("a zero-row MATCH never triggers the LIKE scan", () => {
  const index = new SqliteIndex(":memory:");
  index.add(chunk("needle in a haystack", "one"));

  // "needl" is a token-level miss but a substring-level hit: the old code
  // returned this row through an unbounded LIKE scan. It must now return [].
  assert.deepEqual(index.search("needl", 5), []);
  assert.equal(index.diagnostics.likeFallbackCount, 0, "no fallback for a genuine no-match");

  // A query with no tokens at all is also not a reason to scan the table.
  assert.deepEqual(index.search("!!!", 5), []);
  assert.deepEqual(index.search("", 5), []);
  assert.equal(index.diagnostics.likeFallbackCount, 0);

  // The exact token still hits through FTS.
  assert.equal(index.search("needle", 5)[0]?.id, "one");
  assert.equal(index.diagnostics.likeFallbackCount, 0);
});

test("the LIKE fallback runs only when FTS5 is unavailable, is capped and is counted", () => {
  const index = new SqliteIndex(":memory:", { forceFtsUnavailable: true });
  const total = LIKE_MAX_RESULTS + 10;
  for (let position = 0; position < total; position += 1) {
    index.add(chunk(`needle row ${position}`, `row-${position}`));
  }
  index.add(chunk("no match here", "clean"));

  const okay = index.diagnostics;
  assert.equal(okay.likeFallbackCount, 0);
  assert.equal(okay.lastFallbackAt, null);

  const hits = index.search("needle", 1000);
  assert.equal(hits.length, LIKE_MAX_RESULTS, `results are capped at ${LIKE_MAX_RESULTS}`);
  assert.equal(index.diagnostics.likeFallbackCount, 1, "the fallback is counted");
  assert.equal(index.diagnostics.likeFallbackRows, LIKE_MAX_RESULTS);
  assert.equal(typeof index.diagnostics.lastFallbackAt, "number");

  // topK below the cap still wins.
  assert.equal(index.search("needle", 3).length, 3);
  assert.equal(index.diagnostics.likeFallbackCount, 2);
  assert.equal(index.diagnostics.likeFallbackRows, LIKE_MAX_RESULTS + 3);

  // The scan window itself is bounded to the newest LIKE_SCAN_ROW_CAP rows.
  const windowed = new SqliteIndex(":memory:", { forceFtsUnavailable: true });
  windowed.add(chunk("needle oldest", "oldest"));
  for (let position = 0; position < 5; position += 1) windowed.add(chunk(`filler ${position}`, `filler-${position}`));
  assert.equal(LIKE_SCAN_ROW_CAP, 5000);
  windowed._likeScanRowCap = 3; // shrink the window so the bound is observable
  assert.deepEqual(windowed.search("needle", 10), [], "only the newest rows are scanned");
  windowed._likeScanRowCap = LIKE_SCAN_ROW_CAP;
  assert.equal(windowed.search("needle", 10)[0]?.id, "oldest", "the row is still there");

  // searchWithScores uses the same capped path and reports a score.
  const scored = index.searchWithScores("needle", 2);
  assert.equal(scored.length, 2);
  assert.equal(typeof scored[0].score, "number");
});

test("an FTS syntax error retries the MATCH once instead of scanning the table", () => {
  // One malformed MATCH expression, then normal behaviour: the index must
  // recover through the sanitized retry and never touch the LIKE scan.
  class SyntaxErrorOnceIndex extends SqliteIndex {
    constructor(...args) {
      super(...args);
      this.injected = false;
    }

    _buildFtsQuery(query) {
      if (!this.injected) {
        this.injected = true;
        return 'AND "broken"';
      }
      return super._buildFtsQuery(query);
    }
  }

  const index = new SyntaxErrorOnceIndex(":memory:");
  index.add(chunk("needle in a haystack", "one"));

  const hits = index.search("needle", 5);
  assert.equal(hits[0]?.id, "one", "the retry answered the query");
  assert.equal(index.diagnostics.ftsErrorCount, 1, "the failed MATCH is counted");
  assert.equal(index.diagnostics.likeFallbackCount, 0, "a syntax error is not a reason to scan the table");

  // FTS is still considered available afterwards.
  assert.equal(index.search("haystack", 5)[0]?.id, "one");
  assert.equal(index.diagnostics.likeFallbackCount, 0);
});

test("both indexes expose the same read-only diagnostics shape", () => {
  const local = new LocalIndex();
  local.add(chunk("anything", "x"));
  assert.deepEqual(local.diagnostics, {
    ftsErrorCount: 0,
    likeFallbackCount: 0,
    likeFallbackRows: 0,
    lastFallbackAt: null,
    searchTextMigration: "ok",
  });

  const sqlite = new SqliteIndex(":memory:");
  assert.deepEqual(Object.keys(sqlite.diagnostics).sort(), Object.keys(local.diagnostics).sort());
  assert.equal(sqlite.diagnostics.searchTextMigration, "ok");
  assert.equal(sqlite.diagnostics.ftsErrorCount, 0);
});

// ---------------------------------------------------------------------------
// 6. Bounded reads in one tick: the walk stops at its caps.
// ---------------------------------------------------------------------------

test("a directory ingest bounds its reads with maxFiles and maxTotalBytes", () => {
  assert.equal(DEFAULT_MAX_FILES, 20000);
  assert.equal(DEFAULT_MAX_TOTAL_BYTES, 32 * 1024 * 1024);

  const manyDir = tempDir();
  for (let position = 0; position < 30; position += 1) write(manyDir, `file-${position}.md`, `body ${position}`);
  const capped = ingestDirectoryIncremental({ directory: manyDir, maxFiles: 5 });
  assert.equal(Object.keys(capped.state).length, 5, "at most maxFiles files were read in this tick");
  assert.equal(capped.stats.added, 5);
  assert.equal(capped.stats.truncated, true, "truncation is reported, not silent");

  const bytesDir = tempDir();
  for (let position = 0; position < 5; position += 1) write(bytesDir, `blob-${position}.md`, "z".repeat(400));
  const byBytes = ingestDirectoryIncremental({ directory: bytesDir, maxTotalBytes: 1000 });
  assert.equal(byBytes.chunks.length, 2, "only 800 bytes of content were read, the third file would exceed the cap");
  assert.equal(byBytes.stats.truncated, true);

  // Unlimited enough for this tree: no truncation.
  const whole = ingestDirectoryIncremental({ directory: manyDir });
  assert.equal(whole.stats.truncated, false);
  assert.equal(Object.keys(whole.state).length, 30);
});

// ---------------------------------------------------------------------------
// 7. Public signatures unchanged.
// ---------------------------------------------------------------------------

test("the public ingestion and index signatures are unchanged", () => {
  const dir = tempDir();
  const filePath = write(dir, "note.md", "some note");

  // ingest helpers still return the same types.
  assert.ok(Array.isArray(ingestDirectory(dir)));
  assert.ok(Array.isArray(ingestText({ content: "hello", source: "s", kind: SourceKind.FILE })));
  assert.ok(Array.isArray(ingestFile(filePath)));
  assert.equal(typeof ingestFile(filePath)[0].id, "string");

  // Incremental ingest keeps added/changed/skipped and adds the two counters.
  const incremental = ingestDirectoryIncremental({ directory: dir });
  assert.equal(incremental.stats.added, 1);
  assert.equal(typeof incremental.stats.sizeSkipped, "number");
  assert.equal(typeof incremental.stats.symlinkSkipped, "number");

  // Second run over an unchanged tree is all-skipped, no re-read.
  const second = ingestDirectoryIncremental({ directory: dir, state: incremental.state });
  assert.equal(second.stats.added, 0);
  assert.equal(second.stats.skipped, 1);

  for (const index of [new LocalIndex(), new SqliteIndex(":memory:")]) {
    index.addMany([chunk("alpha beta", "a"), chunk("beta gamma", "b")]);
    assert.equal(typeof index.search, "function");
    assert.equal(index.search("beta", 5).length, 2);
    const scored = index.searchWithScores("beta", 5);
    assert.equal(scored.length, 2);
    assert.ok(scored[0].chunk instanceof Chunk);
    assert.equal(typeof scored[0].score, "number");
    const byKind = index.chunksByKind(SourceKind.FILE, { source: "a.md", limit: 10 });
    assert.equal(byKind.length, 1);
  }
});

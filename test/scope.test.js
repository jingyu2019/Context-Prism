// Session isolation: a window built for one session may only contain that
// session's history/trajectory, while preference/code/file chunks stay shared.
//
// Every test here pins a behavioural contract from docs/SPEC-SESSION-ISOLATION.md:
//   §2.1 ownership rule, §3.1 visibility predicate (I2), §3.2 concurrency (C2/C3),
//   §4.3.2 string cache keys with scope + full fingerprint, §4.3.3 preference
//   scoring, §4.3.4 capture re-entrancy guard, §4.3.5 ingestion handoff H1.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalContextEngine } from "../engine/engine.js";
import { LocalIndex } from "../engine/index.js";
import { SqliteIndex } from "../engine/sqlite_index.js";
import { Chunk, ContextWindow, RetrievedItem, SourceKind, isVisibleInScope, sessionScopeOf } from "../engine/models.js";
import { RetrievalConfig, normalizeScope, retrieve } from "../engine/retrieval.js";

function tempDir(prefix = "lce-scope-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** One history chunk owned by `sessionId` (or unowned when null). */
function historyChunk(sessionId, seq, content) {
  const owned = sessionId !== null;
  return new Chunk({
    id: owned ? `${sessionId}:user:${seq}` : `import:${seq}`,
    source: owned ? `session:${sessionId}` : "history.jsonl",
    kind: SourceKind.HISTORY,
    content,
    metadata: owned ? { sessionId, seq } : {},
  });
}

function sharedChunks() {
  return [
    new Chunk({ id: "pref-1", source: "pref.md", kind: SourceKind.PREFERENCE, content: "quasar preference: concise replies", priority: 5 }),
    new Chunk({ id: "code-1", source: "engine.js", kind: SourceKind.CODE, content: "quasar function assembleContext()" }),
    new Chunk({ id: "file-1", source: "notes.md", kind: SourceKind.FILE, content: "quasar notes on the window budget" }),
  ];
}

function itemIds(window) {
  return window.sections.flatMap((section) => section.items.map((item) => item.chunk.id));
}

/** Ids of history/trajectory items only — the session-scoped surface. */
function scopedItemIds(window) {
  return window.sections
    .flatMap((section) => section.items)
    .filter((item) => [SourceKind.HISTORY, SourceKind.TRAJECTORY].includes(item.chunk.kind))
    .map((item) => item.chunk.id);
}

// ---------------------------------------------------------------------------
// §2.1 / §3.1 — the ownership rule and the visibility predicate
// ---------------------------------------------------------------------------

test("sessionScopeOf reads metadata first, then the session: source convention", () => {
  assert.equal(sessionScopeOf(historyChunk("A", 1, "x")), "A", "metadata.sessionId is authoritative");
  assert.equal(
    sessionScopeOf(new Chunk({ id: "x", source: "session:B", kind: SourceKind.TRAJECTORY, content: "t" })),
    "B",
    "a capture always writes source session:<id>, so a chunk without metadata is still owned",
  );
  assert.equal(sessionScopeOf(historyChunk(null, 2, "imported")), null, "imported corpus is unowned");
  assert.equal(
    sessionScopeOf(new Chunk({ id: "blank", source: "session:A", kind: SourceKind.HISTORY, content: "c", metadata: { sessionId: "   " } })),
    "A",
    "a blank metadata value falls through to the source convention",
  );
  assert.equal(sessionScopeOf(null), null);
});

test("isVisibleInScope: project kinds are shared, foreign session kinds are not", () => {
  const own = historyChunk("A", 1, "a");
  const foreign = historyChunk("B", 1, "b");
  const imported = historyChunk(null, 1, "imported");
  const pref = sharedChunks()[0];
  const cursor = new Chunk({ id: "session_cursor:A", source: "session:A", kind: SourceKind.SESSION_CURSOR, content: "7", metadata: { sessionId: "A", seq: 7 } });

  assert.equal(isVisibleInScope(own, "A"), true);
  assert.equal(isVisibleInScope(foreign, "A"), false, "session B's history must not be visible to A");
  assert.equal(isVisibleInScope(own, "B"), false, "and the rule is symmetric");
  assert.equal(isVisibleInScope(imported, "A"), true, "unowned corpus is project-wide");
  assert.equal(isVisibleInScope(pref, "A"), true, "preferences stay visible to every session");
  assert.equal(isVisibleInScope(cursor, "A"), false, "the capture cursor is a control record, never context");
  assert.equal(isVisibleInScope(own, null), true, "unscoped = whole index (CLI/tests)");

  assert.throws(() => normalizeScope(42), TypeError, "a non-string scope is rejected instead of silently mismatching");
  assert.equal(normalizeScope("  "), null);
  assert.equal(normalizeScope(" A "), "A");
});

test("retrieve() never returns another session's history, on both backends", () => {
  for (const backend of ["json", "sqlite"]) {
    const engine = backend === "sqlite"
      ? new LocalContextEngine({ backend: "sqlite" })
      : new LocalContextEngine({ index: new LocalIndex() });
    engine.addChunks([
      historyChunk("A", 1, "quasar alpha plan belongs to A"),
      historyChunk("B", 1, "quasar alpha plan belongs to B"),
      historyChunk(null, 1, "quasar imported corpus note"),
      ...sharedChunks(),
    ]);

    const forA = retrieve(engine.index, "quasar", new RetrievalConfig({ scope: "A", topK: 20 })).map((item) => item.chunk.id);
    const forB = retrieve(engine.index, "quasar", new RetrievalConfig({ scope: "B", topK: 20 })).map((item) => item.chunk.id);
    const unscoped = retrieve(engine.index, "quasar", new RetrievalConfig({ topK: 20 })).map((item) => item.chunk.id);

    assert.ok(forA.includes("A:user:1"));
    assert.ok(!forA.includes("B:user:1"), `${backend}: A must not retrieve B's history`);
    assert.ok(forB.includes("B:user:1"));
    assert.ok(!forB.includes("A:user:1"), `${backend}: B must not retrieve A's history`);

    for (const shared of ["pref-1", "code-1", "file-1"]) {
      assert.ok(forA.includes(shared), `${backend}: ${shared} is project-wide`);
      assert.ok(forB.includes(shared), `${backend}: ${shared} is project-wide`);
    }
    assert.ok(forA.includes("import:1"), `${backend}: unowned imported history stays project-wide`);

    assert.ok(unscoped.includes("A:user:1") && unscoped.includes("B:user:1"), `${backend}: null scope keeps whole-index semantics`);
  }
});

test("a scoped search over-fetches so a small session is not out-ranked by a large one", () => {
  const engine = new LocalContextEngine({ index: new LocalIndex() });
  // Ten chunks from session B that all match, one from session A.
  const bChunks = Array.from({ length: 10 }, (_unused, i) => historyChunk("B", i, `quasar quasar quasar verbose agent note ${i}`));
  engine.addChunks([...bChunks, historyChunk("A", 1, "quasar target")]);

  const items = retrieve(engine.index, "quasar", new RetrievalConfig({ scope: "A", topK: 3 }));
  assert.equal(items.length, 1, "A's own chunk survives even though B fills the global top-K");
  assert.equal(items[0].chunk.id, "A:user:1");
});

// ---------------------------------------------------------------------------
// §4.3.1 — buildContext / buildContextAsync forward the scope
// ---------------------------------------------------------------------------

test("buildContext and buildContextAsync build a window scoped to one session", async () => {
  const engine = new LocalContextEngine({ index: new LocalIndex() });
  engine.addChunks([
    historyChunk("A", 1, "quasar window for A only"),
    historyChunk("B", 1, "quasar window for B only"),
    new Chunk({ id: "tray-A", source: "session:A", kind: SourceKind.TRAJECTORY, content: "quasar tool result A", metadata: { sessionId: "A" } }),
    new Chunk({ id: "tray-B", source: "session:B", kind: SourceKind.TRAJECTORY, content: "quasar tool result B", metadata: { sessionId: "B" } }),
    ...sharedChunks(),
  ]);

  const windowA = engine.buildContext({ query: "quasar", maxTokens: 2000, reservedOutputTokens: 100, scope: "A" });
  const windowB = engine.buildContext({ query: "quasar", maxTokens: 2000, reservedOutputTokens: 100, scope: "B" });

  assert.equal(windowA.scope, "A");
  assert.equal(windowA.report().scope, "A", "the report exposes which scope produced the window");
  assert.ok(windowA instanceof ContextWindow);

  const idsA = itemIds(windowA);
  const idsB = itemIds(windowB);
  assert.ok(idsA.includes("A:user:1") && idsA.includes("tray-A"), "A's history and trajectory are present");
  assert.ok(!idsA.some((id) => id.startsWith("B:") || id === "tray-B"), "zero chunks from session B");
  assert.ok(idsB.includes("B:user:1") && idsB.includes("tray-B"));
  assert.ok(!idsB.some((id) => id.startsWith("A:") || id === "tray-A"), "zero chunks from session A");

  const asyncA = await engine.buildContextAsync({ query: "quasar", maxTokens: 2000, reservedOutputTokens: 100, scope: "A" });
  assert.equal(asyncA.scope, "A");
  assert.deepEqual(scopedItemIds(asyncA).sort(), ["A:user:1", "tray-A"], "the async path applies the same scope");

  // The scope may also arrive on the config; the two must not disagree silently.
  const viaConfig = engine.buildContext({ query: "quasar", maxTokens: 2000, reservedOutputTokens: 100, retrievalConfig: new RetrievalConfig({ scope: "B" }) });
  assert.deepEqual(scopedItemIds(viaConfig).sort(), ["B:user:1", "tray-B"]);
  assert.throws(
    () => engine.buildContext({ query: "quasar", maxTokens: 2000, reservedOutputTokens: 100, scope: "A", retrievalConfig: new RetrievalConfig({ scope: "B" }) }),
    /conflicting session scope/,
    "argument and config disagreeing is a leak, so it throws",
  );
});

test("scope never leaks into ContextWindow.report() sections", () => {
  const engine = new LocalContextEngine({ index: new LocalIndex() });
  engine.addChunks([historyChunk("A", 1, "quasar a"), historyChunk("B", 1, "quasar b")]);
  const report = engine.buildContext({ query: "quasar", maxTokens: 1200, reservedOutputTokens: 100, scope: "A" }).report();
  const reported = report.sections.flatMap((section) => section.items.map((item) => item.id));
  assert.ok(!reported.includes("B:user:1"));
  assert.equal(report.scope, "A");
});

// ---------------------------------------------------------------------------
// §4.3.2 — cache keys are strings, scope-aware, and complete
// ---------------------------------------------------------------------------

test("cache keys are strings and a repeated assembly actually hits the cache", () => {
  const engine = new LocalContextEngine({ index: new LocalIndex(), cacheSize: 32 });
  engine.addChunks([historyChunk("A", 1, "quasar alpha"), historyChunk("B", 1, "quasar alpha")]);

  const config = new RetrievalConfig({ scope: "A" });
  const key = engine._retrievalCacheKey("quasar alpha", config, "A");
  assert.equal(typeof key, "string", "an array key is compared by identity, so it can never hit");
  assert.equal(typeof engine._compressionCacheKey("quasar alpha", 500, [], "A"), "string");
  assert.match(key, /s:"A"/, "the scope is part of the key");

  engine.buildContext({ query: "quasar alpha", maxTokens: 1200, reservedOutputTokens: 100, scope: "A" });
  const afterFirst = engine.retrievalCache.size;
  engine.buildContext({ query: "quasar alpha", maxTokens: 1200, reservedOutputTokens: 100, scope: "A" });
  assert.equal(engine.retrievalCache.size, afterFirst, "an identical call must reuse the entry, not add one");

  engine.buildContext({ query: "quasar Alpha  ", maxTokens: 1200, reservedOutputTokens: 100, scope: "A" });
  assert.equal(engine.retrievalCache.size, afterFirst, "whitespace/case differences normalize to the same key");
});

test("two scopes back to back each get their own window, not the first one's cached result", () => {
  const engine = new LocalContextEngine({ index: new LocalIndex(), cacheSize: 32 });
  engine.addChunks([
    historyChunk("A", 1, "quasar session alpha detail"),
    historyChunk("B", 1, "quasar session beta detail"),
    ...sharedChunks(),
  ]);

  const keyA = engine._retrievalCacheKey("quasar", new RetrievalConfig({ scope: "A" }), "A");
  const keyB = engine._retrievalCacheKey("quasar", new RetrievalConfig({ scope: "B" }), "B");
  assert.notEqual(keyA, keyB, "the scope must distinguish the entries");

  const first = engine.buildContext({ query: "quasar", maxTokens: 2000, reservedOutputTokens: 100, scope: "A" });
  const second = engine.buildContext({ query: "quasar", maxTokens: 2000, reservedOutputTokens: 100, scope: "B" });

  assert.ok(itemIds(first).includes("A:user:1"));
  assert.ok(!itemIds(second).includes("A:user:1"), "B must not be served A's cached items");
  assert.ok(itemIds(second).includes("B:user:1"));
  assert.equal(engine.retrievalCache.size, 2, "one entry per scope, not a shared one");
});

test("bm25-only and hybrid cannot share a cached ranking (the A/B comparison depends on it)", () => {
  const engine = new LocalContextEngine({ index: new LocalIndex(), cacheSize: 32 });
  engine.addChunks([historyChunk("A", 1, "quasar dynamic context window"), ...sharedChunks()]);

  const query = "quasar dynamic context window";
  const bm25 = new RetrievalConfig({ useSemantic: false });
  const hybrid = new RetrievalConfig({ useSemantic: true });

  const bm25Key = engine._retrievalCacheKey(query, bm25, null);
  const hybridKey = engine._retrievalCacheKey(query, hybrid, null);
  assert.notEqual(bm25Key, hybridKey, "useSemantic must be in the fingerprint");
  assert.notEqual(
    engine._retrievalCacheKey(query, new RetrievalConfig({ semanticWeight: 0.9 }), null),
    hybridKey,
    "semanticWeight changes scores, so it belongs in the fingerprint too",
  );

  // Poison the bm25 entry. A hybrid assembly must not see it; a bm25 assembly must.
  const poison = new RetrievedItem({
    chunk: new Chunk({ id: "poison", source: "poison.md", kind: SourceKind.FILE, content: "poisoned bm25 cache entry" }),
    score: 99,
    reason: "poison",
  });
  engine.retrievalCache.set(bm25Key, [poison]);

  const hybridWindow = engine.buildContext({ query, maxTokens: 2000, reservedOutputTokens: 100, retrievalConfig: hybrid });
  assert.ok(!itemIds(hybridWindow).includes("poison"), "hybrid must not consume the bm25-only entry");

  const bm25Window = engine.buildContext({ query, maxTokens: 2000, reservedOutputTokens: 100, retrievalConfig: bm25 });
  assert.ok(itemIds(bm25Window).includes("poison"), "bm25-only must read its own entry (proves key routing)");
});

// ---------------------------------------------------------------------------
// §4.3.3 — preference scoring follows the query
// ---------------------------------------------------------------------------

test("preferences are ordered by relevance to the query, not by storage position", () => {
  const engine = new LocalContextEngine({ index: new LocalIndex() });
  engine.addChunks([
    new Chunk({ id: "pref-quasar", source: "pref-a.md", kind: SourceKind.PREFERENCE, content: "quasar: answer with the quasar codename", priority: 5 }),
    new Chunk({ id: "pref-nova", source: "pref-b.md", kind: SourceKind.PREFERENCE, content: "nova: answer with the nova codename", priority: 5 }),
  ]);

  const preferenceIds = (window) =>
    window.sections
      .filter((section) => section.title === "User Preferences")
      .flatMap((section) => section.items.map((item) => item.chunk.id));

  const quasarView = engine.buildContext({ query: "quasar codename", maxTokens: 2000, reservedOutputTokens: 100 });
  const novaView = engine.buildContext({ query: "nova codename", maxTokens: 2000, reservedOutputTokens: 100 });

  assert.deepEqual(preferenceIds(quasarView), ["pref-quasar", "pref-nova"]);
  assert.deepEqual(preferenceIds(novaView), ["pref-nova", "pref-quasar"]);
  assert.deepEqual(preferenceIds(quasarView).sort(), ["pref-nova", "pref-quasar"], "both preferences are still always included");
  assert.notEqual(
    quasarView.sections.find((s) => s.title === "User Preferences").items[0].score,
    10.0,
    "the hardcoded 10.0 ladder is gone",
  );
});

// ---------------------------------------------------------------------------
// §4.3.4 — capture re-entrancy guard and cursor monotonicity
// ---------------------------------------------------------------------------

function sessionFixture(id, turns = 3) {
  const events = [];
  let seq = 1;
  for (let i = 0; i < turns; i += 1) {
    events.push({ seq, time: Date.now(), type: "user/message", data: { role: "user", content: [{ type: "text", text: `${id} question ${i}` }] } });
    seq += 1;
    events.push({ seq, time: Date.now(), type: "assistant/message", data: { message: { content: [{ type: "text", text: `${id} answer ${i}` }] } } });
    seq += 1;
    events.push({ seq, time: Date.now(), type: "tool/result", data: { message: { content: [{ type: "text", text: `${id} tool output ${i}` }] } } });
    seq += 1;
  }
  // A system message is re-rendered by the host and must not be captured.
  events.push({ seq, time: Date.now(), type: "system/message", data: { message: { content: [{ type: "text", text: "system prompt" }] } } });
  return { id, header: {}, events };
}

test("a re-entrant capture is coalesced instead of re-inserting the same events", () => {
  const engine = new LocalContextEngine({ index: new LocalIndex() });
  const session = sessionFixture("A", 2);
  const expected = session.events.filter((event) => event.type !== "system/message").length;

  const nested = [];
  const originalAddMany = engine.index.addMany.bind(engine.index);
  engine.index.addMany = (chunks) => {
    // Simulates the second assembly of the same session arriving while the
    // first one is still writing: without the guard this re-reads the events.
    nested.push(engine.captureSessionEvents({ session, cursor: 0 }));
    return originalAddMany(chunks);
  };
  let outer;
  try {
    outer = engine.captureSessionEvents({ session, cursor: 0 });
  } finally {
    engine.index.addMany = originalAddMany;
  }

  assert.equal(nested.length, 1, "the nested call really ran");
  assert.equal(nested[0].reentered, true, "the guard reports the coalesced call");
  assert.equal(nested[0].added, 0, "a coalesced call inserts nothing and owns no accounting");
  assert.equal(outer.reentered, false);
  assert.equal(outer.added, expected);

  const captured = engine.index.chunksByKind(SourceKind.HISTORY).length + engine.index.chunksByKind(SourceKind.TRAJECTORY).length;
  assert.equal(captured, expected, "chunk count equals the event count: no duplication, no loss");
});

test("interleaved capture for one session converges: no double insert, cursor monotone", async () => {
  const engine = new LocalContextEngine({ index: new LocalIndex() });
  const session = sessionFixture("A", 4);
  const expected = session.events.filter((event) => event.type !== "system/message").length;

  // Eight concurrent assemblies for the same session, all reading a stale cursor.
  const results = await Promise.all(
    Array.from({ length: 8 }, async () => {
      await Promise.resolve();
      return engine.captureSessionEvents({ session, cursor: 0 });
    }),
  );

  const captured = engine.index.chunksByKind(SourceKind.HISTORY).length + engine.index.chunksByKind(SourceKind.TRAJECTORY).length;
  assert.equal(captured, expected, "eight interleaved captures still store exactly the event count");
  // The cursor advances past events that project to nothing (a system message),
  // so it lands on the newest seq the session has, exactly as the host reports it.
  assert.equal(engine.sessionCursor("A"), session.events.at(-1).seq, "cursor lands on the newest event seq");
  assert.ok(results.every((result) => result.added === 0 || result.added === expected), "each call either owned the capture or coalesced");
});

test("a stale caller cursor cannot rewind the persisted capture cursor", () => {
  const engine = new LocalContextEngine({ index: new LocalIndex() });
  const session = sessionFixture("A", 2);
  engine.captureSessionEvents({ session });
  const highest = engine.sessionCursor("A");
  assert.ok(highest > 0);

  engine.captureSessionEvents({ session, cursor: 0 });
  assert.equal(engine.sessionCursor("A"), highest, "the persisted cursor is monotone non-decreasing");
});

test("sessions never contend: capture for A does not block or corrupt B", () => {
  const engine = new LocalContextEngine({ index: new LocalIndex() });
  const a = sessionFixture("A", 2);
  const b = sessionFixture("B", 3);
  engine.captureSessionEvents({ session: a });
  engine.captureSessionEvents({ session: b });
  assert.equal(engine.sessionCursor("A"), a.events.at(-1).seq);
  assert.equal(engine.sessionCursor("B"), b.events.at(-1).seq);
  assert.equal(
    engine.index.chunksByKind(SourceKind.HISTORY).filter((chunk) => chunk.metadata.sessionId === "A").length,
    2 * 2,
    "A's two turns produced two history chunks each",
  );
  assert.equal(
    engine.index.chunksByKind(SourceKind.HISTORY).filter((chunk) => chunk.metadata.sessionId === "B").length,
    3 * 2,
  );
});

test("the capture guard is per engine instance, not module state", () => {
  const first = new LocalContextEngine({ index: new LocalIndex() });
  const second = new LocalContextEngine({ index: new LocalIndex() });
  assert.notEqual(first._captureInFlight, second._captureInFlight, "each engine owns its guard map");

  const session = sessionFixture("shared", 1);
  first.captureSessionEvents({ session });
  // If the guard were global, this would be coalesced into a no-op.
  const other = second.captureSessionEvents({ session });
  assert.equal(other.reentered, false);
  assert.ok(other.added > 0, "a different engine on a different index captures independently");
  assert.equal(first._captureInFlight.size, 0, "the guard is released after every capture");
  assert.equal(second._captureInFlight.size, 0);
});

// ---------------------------------------------------------------------------
// §4.3.5 — handoff H1: ingestion bounds surface, addFileIncremental is frozen
// ---------------------------------------------------------------------------

test("addDirectoryIncremental reports what the size bound skipped", () => {
  const engine = new LocalContextEngine({ index: new LocalIndex() });
  const root = tempDir();
  const dir = join(root, "content");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "small.md"), "quasar small note", "utf8");
  writeFileSync(join(dir, "small-two.md"), "quasar second note", "utf8");
  writeFileSync(join(dir, "huge.md"), "x".repeat(4096), "utf8");
  // The state file lives outside the walked tree; inside, it would itself be
  // ingested as a new .json file and mask the "unchanged" assertion.
  const statePath = join(root, "state.json");

  const result = engine.addDirectoryIncremental({ directory: dir, maxFileBytes: 1024, statePath });
  assert.deepEqual(Object.keys(result).sort(), ["added", "changed", "sizeSkipped", "skipped", "symlinkSkipped"]);
  assert.equal(result.sizeSkipped, 1, "the oversized file is reported, not silently dropped");
  assert.ok(result.added >= 2);

  const again = engine.addDirectoryIncremental({ directory: dir, maxFileBytes: 1024, statePath });
  assert.equal(again.added, 0, "an unchanged tree adds nothing on the second pass");
  assert.equal(again.skipped, 2, "unchanged files are counted as skipped");
  assert.equal(again.sizeSkipped, 1, "the bound is still reported on a no-op pass");
});

test("addFileIncremental keeps its exact frozen return shape", () => {
  const engine = new LocalContextEngine({ index: new LocalIndex() });
  const dir = tempDir();
  const file = join(dir, "note.md");
  writeFileSync(file, "first version", "utf8");
  const statePath = join(dir, "state.json");

  assert.deepEqual(engine.addFileIncremental({ path: file, statePath }), { added: 1, changed: 1, skipped: 0 });
  assert.deepEqual(engine.addFileIncremental({ path: file, statePath }), { added: 0, changed: 0, skipped: 1 });
});

// ---------------------------------------------------------------------------
// Regression guard: shares the index with a second session and a second backend
// ---------------------------------------------------------------------------

test("two sessions sharing one sqlite index stay isolated after a reopen", () => {
  const dir = tempDir();
  const dbPath = join(dir, "index.db");
  const engine = new LocalContextEngine({ storagePath: dbPath, backend: "sqlite" });
  engine.addChunks([historyChunk("A", 1, "quasar A private"), historyChunk("B", 1, "quasar B private")]);
  engine.save();

  const reopened = new LocalContextEngine({ storagePath: dbPath, backend: "auto" });
  assert.ok(reopened.index instanceof SqliteIndex, "the reopened index is the sqlite backend");
  const windowA = reopened.buildContext({ query: "quasar", maxTokens: 1200, reservedOutputTokens: 100, scope: "A" });
  assert.deepEqual(scopedItemIds(windowA), ["A:user:1"]);
});

// Regression tests for defects found while porting to DSH 0.2.1-rc.5.
//
// Each one pins a behaviour that was wrong or absent, not a line of code:
// cursor chunks leaking into the model, a pack that omits the separator cost,
// retrieval ranked by hit order instead of term statistics.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalContextEngine } from "../engine/engine.js";
import { LocalIndex } from "../engine/index.js";
import { SqliteIndex } from "../engine/sqlite_index.js";
import { Chunk, SourceKind, RETRIEVABLE_KINDS } from "../engine/models.js";
import { RetrievalConfig, retrieve } from "../engine/retrieval.js";

function tempDb(name = "index.db") {
  return join(mkdtempSync(join(tmpdir(), "lce-fix-")), name);
}

test("session cursor chunks exist but are not retrievable", () => {
  const engine = new LocalContextEngine({ storagePath: tempDb(), backend: "sqlite" });
  engine.addText({ content: "dynamic context window retention", source: "a.md", kind: SourceKind.FILE });
  engine.captureSessionEvents({
    session: { id: "s", events: [{ seq: 0, time: Date.now(), type: "user/message", data: { role: "user", content: [{ type: "text", text: "remember the context window rule" }] } }] },
  });
  assert.equal(engine.sessionCursor("s"), 0, "an event at seq 0 keeps the cursor at its zero default");
  engine.captureSessionEvents({
    session: { id: "s", events: [{ seq: 7, time: Date.now(), type: "user/message", data: { role: "user", content: [{ type: "text", text: "second turn" }] } }] },
  });
  assert.equal(engine.sessionCursor("s"), 7);
  const cursorChunks = engine.index.chunksByKind(SourceKind.SESSION_CURSOR);
  assert.equal(cursorChunks.length, 1, "one cursor row per session, replaced in place");

  const items = retrieve(engine.index, "117", new RetrievalConfig({ topK: 50 }));
  assert.equal(
    items.filter((item) => item.chunk.kind === SourceKind.SESSION_CURSOR).length,
    0,
    "a cursor value must never be retrieved by its own payload",
  );
  assert.ok(RETRIEVABLE_KINDS.includes(SourceKind.FILE));
  assert.ok(!RETRIEVABLE_KINDS.includes(SourceKind.SESSION_CURSOR));
});

test("sqlite chunksByKind filters by source and honours a limit", () => {
  const engine = new LocalContextEngine({ storagePath: tempDb(), backend: "sqlite" });
  for (let i = 0; i < 5; i += 1) {
    engine.addChunks([new Chunk({ id: `s${i}`, source: i % 2 === 0 ? "session:a" : "session:b", kind: SourceKind.HISTORY, content: `message ${i}` })]);
  }
  assert.equal(engine.index.chunksByKind(SourceKind.HISTORY, { source: "session:a" }).length, 3);
  assert.equal(engine.index.chunksByKind(SourceKind.HISTORY, { source: "session:a", limit: 1 }).length, 1);
  // Newest first when filtered by source, so "the latest chunk" is a cheap read.
  assert.equal(engine.index.chunksByKind(SourceKind.HISTORY, { source: "session:a", limit: 1 })[0].id, "s4");
});

test("local index mirrors the sqlite filter semantics", () => {
  const index = new LocalIndex();
  index.addMany([
    new Chunk({ id: "a", source: "session:x", kind: SourceKind.HISTORY, content: "one" }),
    new Chunk({ id: "b", source: "session:y", kind: SourceKind.HISTORY, content: "two" }),
    new Chunk({ id: "c", source: "session:x", kind: SourceKind.HISTORY, content: "three" }),
  ]);
  assert.deepEqual(index.chunksByKind(SourceKind.HISTORY, { source: "session:x" }).map((c) => c.id), ["c", "a"]);
  assert.equal(index.chunksByKind(SourceKind.HISTORY, { limit: 2 }).length, 2);
});

test("retrieval is scored by term statistics, not by the order the index returned rows", () => {
  // Two chunks share the same single hit token. The one that uses the query
  // term more densely must score higher; under the old rank-based shim, the
  // second row always scored lower regardless of its content.
  const index = new LocalIndex();
  index.addMany([
    new Chunk({ id: "sparse", source: "a.md", kind: SourceKind.FILE, content: "budget context ".repeat(1) + "filler ".repeat(40) }),
    new Chunk({ id: "dense", source: "b.md", kind: SourceKind.FILE, content: "budget budget budget context context" }),
  ]);
  const items = retrieve(index, "budget context", new RetrievalConfig({ useSemantic: false, topK: 10, recencyWeight: 0, priorityWeight: 0, sourceWeight: 0 }));
  assert.equal(items[0].chunk.id, "dense");
  const scores = Object.fromEntries(items.map((item) => [item.chunk.id, item.score]));
  assert.ok(scores.dense > scores.sparse);
  assert.ok(items.every((item) => Number.isFinite(item.score)));
});

test("retrieval exposes the BM25 score it used instead of re-ranking by array position", () => {
  const index = new SqliteIndex(tempDb());
  index.addMany([
    new Chunk({ id: "x", source: "a.md", kind: SourceKind.FILE, content: "context window" }),
    new Chunk({ id: "y", source: "b.md", kind: SourceKind.FILE, content: "context window context window" }),
    new Chunk({ id: "z", source: "c.md", kind: SourceKind.FILE, content: "unrelated text" }),
  ]);
  const items = retrieve(index, "context window", new RetrievalConfig({ useSemantic: false, topK: 3, recencyWeight: 0, priorityWeight: 0, sourceWeight: 0 }));
  assert.equal(items.length, 2, "a non-matching chunk must not be retrieved");
  for (const item of items) {
    assert.match(item.reason, /bm25=\d/);
    assert.ok(!/bm25=0\.000/.test(item.reason), "a retrieved chunk must carry a non-zero relevance score");
  }
});

test("packed sections never exceed the budget they were packed against", async () => {
  const { compressItems, compressItemsAsync, PACKING_SEPARATOR_TOKENS } = await import("../engine/compression.js");
  const items = Array.from({ length: 6 }, (_, i) => ({
    chunk: new Chunk({ id: `c${i}`, source: "a.md", kind: SourceKind.FILE, content: "context window detail. ".repeat(4) }),
    score: 1 - i * 0.1,
    reason: "",
  }));
  for (const pack of [compressItems(items, 90, "context"), await compressItemsAsync(items, 90, "context")]) {
    // `ContextSection` renders items joined by a blank line; a real window pays
    // that separator cost, so the packer must too.
    const contentTokens = pack.packed.reduce((sum, p) => sum + p.tokens, 0);
    const rendered = pack.packed.length > 1 ? contentTokens + (pack.packed.length - 1) * PACKING_SEPARATOR_TOKENS : contentTokens;
    assert.ok(rendered <= 90, `packed ${rendered} tokens into a 90-token budget`);
  }
});

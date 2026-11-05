// Session isolation under concurrent multi-session load, end to end.
//
// Contract: docs/SPEC-SESSION-ISOLATION.md §2.1/§3.1 (ownership + visibility)
// and §3.2 (C1–C6, concurrency). This is the test that settles the user-facing
// requirement: several sessions assembling context at the same time, against
// ONE shared workspace index, must not see each other's history and must
// neither duplicate nor lose captured events.
//
// Falsifiability is the point, so the fixture is built to fail a weak
// implementation:
//   - the same index is also assembled WITHOUT a scope, and that window must
//     contain every session. Only with that negative control does the scoped
//     assertion prove the filter is doing the work: an empty index, an
//     unfiltered index, or a predicate that is never exercised would pass the
//     scoped half alone;
//   - chunk counts are checked after EVERY interleaved round against
//     `sum(events revealed so far)`, so a duplication that a later upsert
//     overwrites cannot hide until the end;
//   - the whole run is repeated on a FRESH engine over the same on-disk index:
//     the second run must add zero chunks, leave the persisted cursors alone and
//     produce the same windows. That is the idempotency claim, tested across an
//     engine boundary rather than inside one object's memory.
//
// Nothing here reaches into engine internals to create the isolation: every
// assertion is about what `buildContext()` and the index expose.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalContextEngine } from "../engine/engine.js";
import { LocalIndex } from "../engine/index.js";
import { Chunk, SourceKind } from "../engine/models.js";

/** Enough sessions that accidental serialization or a shared key shows up. */
const SESSION_IDS = Array.from({ length: 8 }, (_unused, index) => `sess-${index}`);
/** Uneven turn counts: the sessions finish capturing at different rounds. */
const TURN_COUNTS = [2, 3, 4, 2, 3, 4, 2, 3];
/** One query for every session, so all eight compete for the same chunks. */
const QUERY = "quasar window budget private";
const PREF_ID = "pref-shared";
/** Project-scoped chunks every session may see; the only non-session records. */
const SHARED_IDS = [PREF_ID, "code-shared"];

const SCOPED_KINDS = new Set([SourceKind.HISTORY, SourceKind.TRAJECTORY]);
const MAX_TOKENS = 20000;
const RESERVED_OUTPUT_TOKENS = 500;

function tempDir(prefix = "lce-concurrency-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Let the event loop run: this is what interleaves the eight workers. */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

const FIXED_TIME = 1_700_000_000_000; // seconds-scale drift is irrelevant; determinism is not

/**
 * One session's full event log, plus the live `session` object the engine reads.
 *
 * Per turn the log holds three capturable events (user, assistant, tool result)
 * and, once at the end, a `system/message` that projects to nothing. The expected
 * chunk count is therefore `turns * 3`, never `session.events.length`: a reader
 * that captures the system prompt shows up as a count mismatch.
 */
function makeSpec(id, turns) {
  const events = [];
  let seq = 1;
  for (let turn = 0; turn < turns; turn += 1) {
    const at = FIXED_TIME + turn * 1000;
    events.push({
      seq: seq++,
      time: at,
      type: "user/message",
      data: {
        message: {
          role: "user",
          content: [{ type: "text", text: `quasar ${id} user turn ${turn}: keep this window private` }],
        },
      },
    });
    events.push({
      seq: seq++,
      time: at + 1,
      type: "assistant/message",
      data: {
        message: {
          role: "assistant",
          content: [{ type: "text", text: `quasar ${id} assistant turn ${turn}: the budget stays local` }],
        },
      },
    });
    events.push({
      seq: seq++,
      time: at + 2,
      type: "tool/result",
      data: {
        message: { content: [{ type: "text", text: `quasar ${id} tool output turn ${turn}` }] },
      },
    });
  }
  return {
    id,
    turns,
    events,
    revealed: 0,
    systemSeq: seq,
    session: { id, header: { id }, events: [] },
  };
}

function makeSpecs() {
  return SESSION_IDS.map((id, index) => makeSpec(id, TURN_COUNTS[index]));
}

/** Publish this session's next turn, so capture really has new events per round. */
function revealNextTurn(spec) {
  if (spec.revealed >= spec.turns) return false;
  const start = spec.revealed * 3;
  spec.session.events.push(...spec.events.slice(start, start + 3));
  spec.revealed += 1;
  if (spec.revealed === spec.turns) {
    spec.session.events.push({
      seq: spec.systemSeq,
      time: spec.events.at(-1).time + 1,
      type: "system/message",
      data: { message: { content: [{ type: "text", text: "system prompt, re-rendered by the host" }] } },
    });
  }
  return true;
}

/** Chunk ids are `<sessionId>:<label>:<seq>`; the prefix is the owner. */
function ownerOf(chunkId) {
  return String(chunkId).split(":")[0];
}

function allItems(window) {
  return window.sections.flatMap((section) => section.items);
}

function scopedItems(window) {
  return allItems(window).filter((item) => SCOPED_KINDS.has(item.chunk.kind));
}

function itemIds(window) {
  return allItems(window).map((item) => item.chunk.id);
}

function sessionChunks(engine) {
  return [
    ...engine.index.chunksByKind(SourceKind.HISTORY),
    ...engine.index.chunksByKind(SourceKind.TRAJECTORY),
  ];
}

/**
 * The count invariant, checked after every round:
 *   indexed history+trajectory chunks === Σ (events revealed per session)
 * with unique ids, correct ownership and the per-session cursor as the only
 * other records in the index.
 */
function assertCaptured(label, engine, specs, { total = null, perOwner = (spec) => spec.revealed * 3 } = {}) {
  const chunks = sessionChunks(engine);
  const expectedTotal = total ?? specs.reduce((sum, spec) => sum + perOwner(spec), 0);

  assert.equal(
    chunks.length,
    expectedTotal,
    `${label}: indexed history ${chunks.length} != sum of per-session events ${expectedTotal}`,
  );

  const ids = chunks.map((chunk) => chunk.id);
  assert.equal(new Set(ids).size, ids.length, `${label}: duplicated chunk ids under interleaving`);

  const byOwner = new Map();
  for (const chunk of chunks) {
    const owner = ownerOf(chunk.id);
    byOwner.set(owner, (byOwner.get(owner) || 0) + 1);
    assert.equal(chunk.metadata?.sessionId, owner, `${label}: ${chunk.id} has foreign metadata.sessionId`);
  }
  for (const spec of specs) {
    const want = perOwner(spec);
    assert.equal(
      byOwner.get(spec.id) || 0,
      want,
      `${label}: ${spec.id} indexed ${byOwner.get(spec.id) || 0} chunks, expected ${want}`,
    );
  }

  // One control record per session, and nothing else: the capture cursor is not
  // retrievable and is the only chunk that is not history/trajectory here.
  assert.equal(
    engine.index.allChunks().length,
    expectedTotal + specs.length + SHARED_IDS.length,
    `${label}: index holds unexpected extra records (only cursors and project chunks are allowed)`,
  );

  return { total: chunks.length, ids: ids.slice().sort() };
}

/** Every scoped window may contain only its own session's history. */
function assertIsolated(results, round) {
  for (const { spec, window } of results) {
    assert.equal(window.scope, spec.id, `round ${round}: ${spec.id} window is scoped to another session`);
    const items = scopedItems(window);
    assert.ok(items.length > 0, `round ${round}: ${spec.id} window lost its own history`);
    const owners = new Set(items.map((item) => ownerOf(item.chunk.id)));
    assert.deepEqual(
      [...owners],
      [spec.id],
      `round ${round}: ${spec.id} window contains history from ${[...owners].join(", ")}`,
    );
    assert.ok(
      allItems(window).every((item) => item.chunk.kind !== SourceKind.SESSION_CURSOR),
      `round ${round}: ${spec.id} window rendered the capture cursor`,
    );
    assert.ok(
      allItems(window).some((item) => item.chunk.id === PREF_ID),
      `round ${round}: ${spec.id} lost the project-wide preference (over-filtering)`,
    );
  }
}

/**
 * One interleaved round: reveal → capture → assemble, all eight at once.
 *
 * `maxInFlight` is measured rather than assumed: if the eight workers were
 * accidentally serialized (an await that never yields, a shared mutex), the
 * test would stop being a concurrency test without anyone noticing.
 */
async function runRound(engine, specs) {
  const counter = { inFlight: 0, maxInFlight: 0 };
  const results = await Promise.all(
    specs.map(async (spec) => {
      counter.inFlight += 1;
      counter.maxInFlight = Math.max(counter.maxInFlight, counter.inFlight);
      try {
        revealNextTurn(spec);
        await tick();
        const capture = engine.captureSessionEvents({ session: spec.session });
        await tick();
        const window = engine.buildContext({
          query: QUERY,
          maxTokens: MAX_TOKENS,
          reservedOutputTokens: RESERVED_OUTPUT_TOKENS,
          scope: spec.id,
        });
        return { spec, capture, window };
      } finally {
        counter.inFlight -= 1;
      }
    }),
  );
  return { results, maxInFlight: counter.maxInFlight };
}

async function runAllRounds(engine, specs, expectation = null) {
  const rounds = Math.max(...specs.map((spec) => spec.turns));
  const windows = new Map();
  const captures = [];
  let maxInFlight = 0;
  for (let round = 1; round <= rounds; round += 1) {
    const { results, maxInFlight: roundMax } = await runRound(engine, specs);
    maxInFlight = Math.max(maxInFlight, roundMax);
    assertIsolated(results, round);
    assertCaptured(`round ${round}`, engine, specs, expectation ?? {});
    for (const { spec, capture, window } of results) {
      windows.set(spec.id, window);
      captures.push({ sessionId: spec.id, ...capture });
    }
  }
  return { windows, captures, maxInFlight };
}

/** Seed the project-wide material every session is allowed to see. */
function seedSharedChunks(engine) {
  engine.addChunks([
    new Chunk({
      id: PREF_ID,
      source: "preferences.md",
      kind: SourceKind.PREFERENCE,
      content: "quasar preferences: keep answers concise and cite the window budget",
      priority: 5,
      timestamp: FIXED_TIME / 1000,
    }),
    new Chunk({
      id: "code-shared",
      source: "engine/retrieval.js",
      kind: SourceKind.CODE,
      content: "quasar retrieve() applies the visibility predicate before scoring",
      timestamp: FIXED_TIME / 1000,
    }),
  ]);
}

test("eight sessions interleaving capture and assembly against one shared SQLite index never leak", async () => {
  const dbPath = join(tempDir(), "workspace.db");
  const engine = new LocalContextEngine({ storagePath: dbPath, backend: "sqlite" });
  seedSharedChunks(engine);

  const specs = makeSpecs();
  const { windows, captures, maxInFlight } = await runAllRounds(engine, specs);

  assert.equal(specs.length, 8, "the stress case really is eight concurrent sessions");
  assert.equal(maxInFlight, 8, "all eight sessions must be in flight at once, not accidentally serialized");
  assert.ok(captures.every((capture) => capture.reentered === false), "no two workers shared a capture");

  const snapshot = assertCaptured("after all rounds", engine, specs);
  const cursors = new Map(specs.map((spec) => [spec.id, engine.sessionCursor(spec.id)]));
  for (const spec of specs) {
    assert.equal(cursors.get(spec.id), spec.systemSeq, `${spec.id}: cursor must reach the newest event`);
  }

  // ---- negative control: the same index, the same query, no scope ----
  // If this window did NOT see every session, the scoped assertions above would
  // be vacuous: there would be nothing for the filter to have excluded.
  const unscoped = engine.buildContext({
    query: QUERY,
    maxTokens: MAX_TOKENS * 2,
    reservedOutputTokens: RESERVED_OUTPUT_TOKENS,
  });
  assert.equal(unscoped.scope, null, "the control really is unscoped");
  const unscopedOwners = new Set(scopedItems(unscoped).map((item) => ownerOf(item.chunk.id)));
  assert.deepEqual(
    [...unscopedOwners].sort(),
    [...SESSION_IDS].sort(),
    "without a scope the shared index exposes all eight sessions — the filter is what stops the leak",
  );

  // The other falsifier: a scope nobody owns must see no session history. An
  // engine that ignored `scope` would return all 69 chunks here too.
  const unknownScope = engine.buildContext({
    query: QUERY,
    maxTokens: MAX_TOKENS,
    reservedOutputTokens: RESERVED_OUTPUT_TOKENS,
    scope: "sess-absent",
  });
  assert.equal(scopedItems(unknownScope).length, 0, "an unknown scope must see zero session history");
  assert.ok(
    allItems(unknownScope).some((item) => item.chunk.id === PREF_ID),
    "but project-wide material is still visible",
  );

  const firstWindows = new Map([...windows].map(([id, window]) => [id, itemIds(window).sort()]));
  const firstTokens = new Map([...windows].map(([id, window]) => [id, window.totalTokens]));

  // ---- second run: a fresh engine over the SAME on-disk index, same work ----
  engine.index.close();
  const secondEngine = new LocalContextEngine({ storagePath: dbPath, backend: "sqlite" });
  const secondSpecs = makeSpecs();
  const rerunExpectation = { total: snapshot.total, perOwner: (spec) => spec.turns * 3 };
  const second = await runAllRounds(secondEngine, secondSpecs, rerunExpectation);

  const secondSnapshot = assertCaptured("second run", secondEngine, secondSpecs, rerunExpectation);
  assert.equal(secondSnapshot.total, snapshot.total, "second run added chunks: capture is not idempotent");
  assert.deepEqual(secondSnapshot.ids, snapshot.ids, "second run changed chunk identity instead of upserting");
  assert.ok(
    second.captures.every((capture) => capture.reentered === false),
    "the second run is sequential per session, so nothing may report reentry",
  );

  for (const spec of secondSpecs) {
    assert.equal(
      secondEngine.sessionCursor(spec.id),
      cursors.get(spec.id),
      `${spec.id}: persisted cursor moved on a repeat capture`,
    );
    assert.deepEqual(
      itemIds(second.windows.get(spec.id)).sort(),
      firstWindows.get(spec.id),
      `${spec.id}: second run produced a different window`,
    );
    assert.equal(
      second.windows.get(spec.id).totalTokens,
      firstTokens.get(spec.id),
      `${spec.id}: second run produced a different token cost`,
    );
  }

  // The control is stable too: a repeat unscoped assembly sees all eight again,
  // which is exactly what the scoped windows must never do.
  const repeatUnscoped = secondEngine.buildContext({
    query: QUERY,
    maxTokens: MAX_TOKENS * 2,
    reservedOutputTokens: RESERVED_OUTPUT_TOKENS,
  });
  assert.deepEqual(
    [...new Set(scopedItems(repeatUnscoped).map((item) => ownerOf(item.chunk.id)))].sort(),
    [...SESSION_IDS].sort(),
  );

  secondEngine.index.close();
});

test("the same interleaving is isolated and idempotent on the JSON backend, shared across two engines", async () => {
  const sharedIndex = new LocalIndex();
  const engine = new LocalContextEngine({ index: sharedIndex });
  seedSharedChunks(engine);

  const specs = makeSpecs();
  const { windows } = await runAllRounds(engine, specs);
  const snapshot = assertCaptured("json run 1", engine, specs);
  const firstWindows = new Map([...windows].map(([id, window]) => [id, itemIds(window).sort()]));

  const unscoped = engine.buildContext({
    query: QUERY,
    maxTokens: MAX_TOKENS * 2,
    reservedOutputTokens: RESERVED_OUTPUT_TOKENS,
  });
  assert.deepEqual(
    [...new Set(scopedItems(unscoped).map((item) => ownerOf(item.chunk.id)))].sort(),
    [...SESSION_IDS].sort(),
    "json: the unscoped control must see every session",
  );

  // A second engine over the SAME index: module-level state (a global guard or
  // a module-level cursor map) would leak between these two objects.
  const secondEngine = new LocalContextEngine({ index: sharedIndex });
  assert.notEqual(engine._captureInFlight, secondEngine._captureInFlight, "the capture guard is per engine");

  const secondSpecs = makeSpecs();
  const rerunExpectation = { total: snapshot.total, perOwner: (spec) => spec.turns * 3 };
  const second = await runAllRounds(secondEngine, secondSpecs, rerunExpectation);
  const after = assertCaptured("json run 2", secondEngine, secondSpecs, rerunExpectation);

  assert.equal(after.total, snapshot.total, "json: second run added chunks");
  assert.deepEqual(after.ids, snapshot.ids, "json: second run changed chunk identity");
  for (const spec of secondSpecs) {
    assert.deepEqual(
      itemIds(second.windows.get(spec.id)).sort(),
      firstWindows.get(spec.id),
      `json: ${spec.id} window changed on the repeat run`,
    );
  }
  assert.equal(engine._captureInFlight.size, 0, "the guard is released after every capture");
  assert.equal(secondEngine._captureInFlight.size, 0);
});

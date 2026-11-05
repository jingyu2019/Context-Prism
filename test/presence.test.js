// Presence-aware injection (v0.10).
//
// The rule under test is one predicate with two outcomes: a retrieved chunk
// whose text the LIVE request already carries is duplication and is dropped; a
// chunk whose text it does not carry is kept — project material the model has
// not read, or history a compaction `replace` removed from the surface, which is
// exactly what must still be injected.
//
// Presence ground truth is `Session.deriveMessages()`, never the index. These
// tests assert it from both directions so a "history off by default"
// implementation cannot pass: it would satisfy the drop case and fail the
// compaction-restore case.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Chunk, SourceKind, estimateTokens } from "../engine/models.js";
import { LocalContextEngine } from "../engine/engine.js";
import { buildPresenceIndex, DEFAULT_MAX_HAYSTACK_CHARS, normalizeForPresence, toolCallText } from "../engine/presence.js";
import { blocksToText, describeEvent } from "../engine/session_events.js";
import { PROMPT_CONTEXT_NAME, Config, apply, diagnostics } from "../lib/index.js";

// ---------------------------------------------------------------------------
// 1. The presence index itself
// ---------------------------------------------------------------------------

test("normalizeForPresence lowercases, collapses whitespace and trims", () => {
  assert.equal(normalizeForPresence("  Hello\n\n\tWorld  "), "hello world");
  assert.equal(normalizeForPresence("a  b   c"), "a b c");
  assert.equal(normalizeForPresence(""), "");
  assert.equal(normalizeForPresence(null), "");
  assert.equal(normalizeForPresence(undefined), "");
});

test("a chunk that is a prefix of a live message counts as present", () => {
  const live = "The quick brown fox jumps over the lazy dog and then rests.";
  const index = buildPresenceIndex([{ role: "user", content: [{ type: "text", text: live }] }]);

  // Full text, a truncated prefix (the 8000-char per-chunk truncation), and a
  // case/whitespace-shifted prefix must all match.
  assert.equal(index.contains(live), true);
  assert.equal(index.contains(live.slice(0, 30)), true);
  assert.equal(index.contains("the   QUICK brown\nfox"), true);
  assert.equal(index.contains("a fact that is not in the request"), false);
  assert.equal(index.messageCount, 1);
});

test("content may be a string or text blocks, and only text blocks count", () => {
  const blocks = buildPresenceIndex([
    { role: "assistant", content: [{ type: "text", text: "alpha" }, { type: "text", text: "beta" }] },
  ]);
  assert.equal(blocks.contains("alpha beta"), true);
  assert.equal(blocks.contains("alpha"), true);

  const stringContent = buildPresenceIndex([{ role: "user", content: "gamma delta" }]);
  assert.equal(stringContent.contains("gamma delta"), true);

  const imageOnly = buildPresenceIndex([{ role: "user", content: [{ type: "image", url: "x.png" }] }]);
  assert.equal(imageOnly.isEmpty, true);
  assert.equal(imageOnly.contains("[image]"), false, "a marker is not text the request carries");
});

test("blank chunk text is never present", () => {
  const index = buildPresenceIndex([{ role: "user", content: "anything at all" }]);
  assert.equal(index.contains(""), false);
  assert.equal(index.contains("   "), false);
  assert.equal(index.contains("\n\t "), false);
  assert.equal(index.contains(null), false);
  assert.equal(index.contains(undefined), false);
});

test("the plugin's own formatting prefixes do not decide presence", () => {
  const live = "the vault key rotates every ninety days";
  const index = buildPresenceIndex([{ role: "user", content: [{ type: "text", text: live }] }]);

  // Capture stores `user: <text>`; rendering adds `[kind | source]`.
  assert.equal(index.contains(`user: ${live}`), true);
  assert.equal(index.contains(`assistant: ${live}`), true);
  assert.equal(index.contains(`[history | session:s1]\nuser: ${live}`), true);
  assert.equal(index.contains(`[history | session:s1]\n${live}`), true);
});

test("tool-call blocks are request text: name and arguments are judged present", () => {
  const argumentsJson = '{"path":"src/ledger/3.js","limit":40}';
  const index = buildPresenceIndex([
    { role: "assistant", content: [{ type: "tool-call", id: "call_1", name: "read_file", arguments: argumentsJson }] },
  ]);

  // What capture stores for the same invocation, and the bare arguments body.
  assert.equal(index.contains(`[tool/call read_file] ${argumentsJson}`), true);
  assert.equal(index.contains(argumentsJson), true);
  // A different invocation is not the one in the request.
  assert.equal(index.contains(`[tool/call read_file] {"path":"src/other.js"}`), false);
  assert.equal(index.contains('[tool/call write_file] {"path":"src/ledger/3.js"}'), false);
});

test("a chunk captured from a tool/call event matches the live block that produced it", () => {
  // Symmetry is the contract: presence spells the invocation the way capture
  // stores it. If either side drifts, this fails and the duplication is back.
  const event = {
    seq: 7,
    type: "tool/call",
    data: { name: "read_file", arguments: '{"path":"src/ledger/3.js","limit":40}' },
  };
  const captured = describeEvent(event, "symmetry-session");
  assert.ok(captured, "capture must project a tool/call event");
  assert.ok(captured.content.includes("[tool/call read_file]"));

  const live = [
    {
      role: "assistant",
      content: [{ type: "tool-call", id: "call_1", name: "read_file", arguments: event.data.arguments }],
    },
  ];
  assert.equal(
    buildPresenceIndex(live).contains(captured.content),
    true,
    "the chunk capture stored must match the live block that produced it",
  );

  const otherInvocation = [
    {
      role: "assistant",
      content: [{ type: "tool-call", id: "call_2", name: "read_file", arguments: '{"path":"src/other.js"}' }],
    },
  ];
  assert.equal(buildPresenceIndex(otherInvocation).contains(captured.content), false);
});

test("R-001: a short common token is not evidence, and a hit inside a word is not a hit", () => {
  const index = buildPresenceIndex([{ role: "user", content: "the token budget is fine" }]);

  // "ok" occurs inside "token", but it is not what the request says.
  assert.equal(index.contains("ok"), false);
  assert.equal(index.contains("OK"), false);
  assert.equal(index.contains("the"), false, "a 3-letter body is too weak to withhold anything");
  assert.equal(index.contains("fix bug"), false, "no run long enough to be evidence");
  // A real word still matches, including at a word boundary.
  assert.equal(index.contains("token"), true);
  assert.equal(index.contains("budget is fine"), true);
  // In-word matches of otherwise substantial needles are rejected too.
  const boundaries = buildPresenceIndex([{ role: "user", content: "unrelated the quickest thing" }]);
  assert.equal(boundaries.contains("the quick"), false, "a mid-word prefix is not literal presence");
  const messageStart = buildPresenceIndex([{ role: "user", content: "the quickest thing happened" }]);
  assert.equal(messageStart.contains("the quick"), true, "a literal prefix of a message is present");
});

test("messages never match across their boundary", () => {
  const index = buildPresenceIndex([{ content: "alpha" }, { content: "beta" }]);
  assert.equal(index.contains("alpha"), true);
  assert.equal(index.contains("beta"), true);
  assert.equal(index.contains("alpha beta"), false, "the sentinel separator forbids a cross-message match");
});

test("the haystack is capped and past the cap presence is still exact", () => {
  const long = "x".repeat(50);
  const capped = buildPresenceIndex(
    [{ content: "first message body" }, { content: long }, { content: "last message body" }],
    { maxHaystackChars: 40 },
  );
  assert.equal(capped.capped, true);
  assert.ok(capped.overflowCount >= 1);
  // R-002: `haystackChars` is the cap-limited figure; `chars` reports every
  // character presence actually read, overflow included, so it is larger than
  // the capped haystack rather than silently clamped to it.
  assert.ok(capped.haystackChars <= 40);
  assert.equal(capped.chars, "first message body".length + long.length + "last message body".length);
  assert.ok(capped.chars > capped.haystackChars, "chars must account for the overflow, not just the haystack");
  // The first message fit, the rest live outside the haystack and are scanned
  // individually — presence stays correct instead of silently false.
  assert.equal(capped.contains("first message body"), true);
  assert.equal(capped.contains("last message body"), true);
  assert.equal(capped.contains(long.slice(0, 10)), true);
  assert.equal(capped.contains("not there"), false);
  assert.equal(buildPresenceIndex([{ content: "x" }]).chars <= DEFAULT_MAX_HAYSTACK_CHARS, true);
});

test("a request with no messages makes nothing present", () => {
  const empty = buildPresenceIndex([]);
  assert.equal(empty.isEmpty, true);
  assert.equal(empty.contains("anything"), false);
  assert.equal(buildPresenceIndex(null).isEmpty, true);
});

// ---------------------------------------------------------------------------
// 2. Engine: drop present, keep absent, before budgeting
// ---------------------------------------------------------------------------

/** Query, budget and fixtures shared by the engine-level cases. */
function presenceEngine() {
  const engine = new LocalContextEngine();
  const duplicated = "duplicate needle noise ".repeat(400); // ~2000 tokens
  const absentAlpha = "alpha needle note about release flags";
  const absentBeta = "beta needle note about rollback steps";
  engine.addChunks([
    // Highest priority so that, without dedupe, it wins the budget and starves
    // the two absent chunks — which is precisely the waste being removed.
    new Chunk({ id: "dup", source: "dup.md", kind: SourceKind.FILE, content: duplicated, priority: 10 }),
    new Chunk({ id: "alpha", source: "alpha.md", kind: SourceKind.FILE, content: absentAlpha }),
    new Chunk({ id: "beta", source: "beta.md", kind: SourceKind.FILE, content: absentBeta }),
  ]);
  const presence = buildPresenceIndex([{ role: "user", content: [{ type: "text", text: duplicated }] }]);
  return { engine, presence, duplicated, absentAlpha, absentBeta };
}

const BUDGET = { query: "needle", maxTokens: 280, reservedOutputTokens: 80 };

test("buildContext drops present items, keeps absent ones, and reuses the freed budget", () => {
  const { engine, presence } = presenceEngine();

  const control = engine.buildContext({ ...BUDGET });
  const controlIds = control.report().sections.flatMap((section) => section.items.map((item) => item.id));
  assert.deepEqual(controlIds, ["dup"], "baseline: the duplicate eats the budget and the absent items are starved");
  assert.ok(control.omittedCount >= 2);

  const window = engine.buildContext({ ...BUDGET, presence });
  const ids = window.report().sections.flatMap((section) => section.items.map((item) => item.id)).sort();
  assert.deepEqual(ids, ["alpha", "beta"], "both absent chunks survive; the present one is dropped");
  // The drop happened before budgeting: both survivors are packed whole, not
  // compressed into a budget the duplicate had already spent.
  assert.equal(window.report().sections.every((section) => section.compressed === false), true);
  assert.equal(window.text.includes("alpha needle note"), true);
  assert.equal(window.text.includes("beta needle note"), true);
  assert.equal(window.text.includes("duplicate needle noise"), false);
});

test("the realised saving is reported, and it is NOT the candidate pool", () => {
  const { engine, presence, duplicated } = presenceEngine();
  const control = engine.buildContext({ ...BUDGET });
  // Explicit opt-in: the counterfactual is a diagnostic, off on the hot path.
  const window = engine.buildContext({ ...BUDGET, presence, measureSavings: true });
  const report = window.report();

  // Independent realisation: material the unfiltered window carries minus the
  // material this one carries, in the report's own item-token units.
  const material = (w) =>
    w
      .report()
      .sections.filter((section) => section.title !== "Omitted Memory")
      .flatMap((section) => section.items)
      .reduce((sum, item) => sum + item.tokens, 0);
  const realised = material(control) - material(window);

  assert.equal(report.dupDroppedCount, 1);
  assert.equal(window.dupDroppedCount, 1);
  assert.ok(realised > 1000, `the realised saving must be material, got ${realised}`);
  assert.equal(report.dupSavedTokens, realised, "the reported saving must equal the realised delta");
  assert.equal(window.dupSavedTokens, realised);

  // The candidate pool is a DIFFERENT, larger number — the duplicate's full
  // cost, part of which the budget would have omitted anyway. If the two were
  // equal this test could pass by coincidence.
  assert.equal(report.dupCandidateTokens, estimateTokens(duplicated));
  assert.notEqual(report.dupCandidateTokens, report.dupSavedTokens);
  assert.equal(report.dupCandidateTokens - report.dupSavedTokens, material(window));
  // The legacy alias `dupDroppedTokens` is the pool, documented as such; it is
  // exactly the misreadable number this repair replaced with dupSavedTokens.
  assert.equal(report.dupDroppedTokens, report.dupCandidateTokens);
  assert.notEqual(report.dupDroppedTokens, report.dupSavedTokens);

  const plain = control.report();
  assert.equal(plain.dupDroppedCount, 0);
  assert.equal(plain.dupSavedTokens, 0);
  assert.equal(plain.dupCandidateTokens, 0);
});

test("when every retrieved item is already present the window is the empty contribution", () => {
  const { engine, presence, duplicated, absentAlpha, absentBeta } = presenceEngine();
  const everything = buildPresenceIndex([
    { role: "user", content: [{ type: "text", text: `${duplicated}\n${absentAlpha}\n${absentBeta}` }] },
  ]);
  const window = engine.buildContext({ ...BUDGET, presence: everything, measureSavings: true });
  assert.equal(window.text, "", "an empty contribution, not a half-built window");
  assert.equal(window.sections.length, 0);
  assert.equal(window.totalTokens, 0);
  assert.equal(window.report().dupDroppedCount, 3);
  assert.ok(window.report().dupSavedTokens > 0, "the whole baseline window is the realised saving");
  assert.ok(window.report().dupCandidateTokens > 0);
});

test("dedupeAgainstPrompt defaults to true and turning it off restores the previous behaviour exactly", () => {
  assert.equal(Config({}).dedupeAgainstPrompt, true, "the plugin config default is on");
  const { engine, presence } = presenceEngine();
  const before = engine.buildContext({ ...BUDGET });
  // No flag passed: the engine default is what the drop test above already
  // relied on; this asserts it directly.
  const defaulted = engine.buildContext({ ...BUDGET, presence });
  assert.equal(defaulted.dupDroppedCount, 1);

  const off = engine.buildContext({ ...BUDGET, presence, dedupeAgainstPrompt: false });
  assert.deepEqual(off.report(), before.report(), "the switch off is the old window, field for field");
  assert.equal(off.text, before.text);
  assert.equal(off.totalTokens, before.totalTokens);
  assert.equal(off.dupDroppedCount, 0);
});

test("a presence index without contains is ignored rather than trusted", () => {
  const { engine } = presenceEngine();
  const control = engine.buildContext({ ...BUDGET });
  const window = engine.buildContext({ ...BUDGET, presence: { messages: [] } });
  assert.deepEqual(window.report(), control.report());
});

test("project material absent from the request — code, files, preferences — is still injected", () => {
  const engine = new LocalContextEngine();
  engine.addChunks([
    new Chunk({ id: "hist", source: "session:s1", kind: SourceKind.HISTORY, content: "user: the vault key rotates every ninety days", metadata: { sessionId: "s1" } }),
    new Chunk({ id: "code", source: "src/vault.js", kind: SourceKind.CODE, content: "// vault rotation\nexport function rotateVaultKey() { return scheduleRotation(90); }" }),
    new Chunk({ id: "file", source: "docs/ops.md", kind: SourceKind.FILE, content: "Vault rotation runbook: schedule rotation before the ninety day deadline." }),
    new Chunk({ id: "pref", source: "user.md", kind: SourceKind.PREFERENCE, content: "Prefer concise local-first answers about vault rotation." }),
  ]);
  const live = buildPresenceIndex([
    { role: "user", content: [{ type: "text", text: "the vault key rotates every ninety days" }] },
  ]);
  const window = engine.buildContext({
    query: "vault rotation",
    maxTokens: 600,
    reservedOutputTokens: 100,
    presence: live,
    scope: "s1",
  });
  const ids = window.report().sections.flatMap((section) => section.items.map((item) => item.id)).sort();
  assert.deepEqual(ids, ["code", "file", "pref"], "history is present in the request; project material is not");
  assert.equal(window.report().dupDroppedCount, 1);
  assert.equal(window.text.includes("rotateVaultKey"), true);
  assert.equal(window.text.includes("Vault rotation runbook"), true);
  assert.equal(window.text.includes("concise local-first"), true);
  assert.equal(window.text.includes("vault key rotates"), false);
});

test("buildContextAsync applies the same predicate in the same position", async () => {
  const { engine, presence, duplicated, absentAlpha, absentBeta } = presenceEngine();
  const window = await engine.buildContextAsync({ ...BUDGET, presence });
  const ids = window.report().sections.flatMap((section) => section.items.map((item) => item.id)).sort();
  assert.deepEqual(ids, ["alpha", "beta"]);
  assert.equal(window.report().dupDroppedCount, 1);

  const everything = await engine.buildContextAsync({
    ...BUDGET,
    presence: buildPresenceIndex([{ content: `${duplicated}\n${absentAlpha}\n${absentBeta}` }]),
  });
  assert.equal(everything.text, "");
  assert.equal(everything.report().dupDroppedCount, 3);
});

// ---------------------------------------------------------------------------
// 2b. Tool-call-heavy sessions (F1) and short-token safety (R-001)
// ---------------------------------------------------------------------------

/** Whitespace/case canonical form, independent of engine/presence.js. */
function canonical(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Capture's own decoration, stripped the way a reader would. */
function storedBody(content) {
  return canonical(
    canonical(content)
      .replace(/^(?:\[[^\]\n]{0,120}\][ \t]*)+/, "")
      .replace(/^(?:user|assistant|developer|system|tool)[ \t]*:[ \t]*/, ""),
  );
}

/** The text a live message contributes, tool-call blocks included. */
function liveText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block?.type === "text" && typeof block.text === "string") return block.text;
      if (block?.type === "tool-call") return `[tool/call ${block.name ?? ""}] ${block.arguments ?? ""}`;
      return "";
    })
    .join("\n");
}

test("tool-call-heavy session: after dedupe nothing tool-call-sourced is re-injected", () => {
  const engine = new LocalContextEngine();
  const sessionId = "toolcall-heavy";
  const events = [];
  for (let turn = 1; turn <= 6; turn += 1) {
    events.push({
      seq: events.length,
      type: "user/message",
      data: { role: "user", content: [{ type: "text", text: `how does ledger settlement step ${turn} work in the reconciliation pipeline` }] },
    });
    events.push({
      seq: events.length,
      type: "assistant/message",
      data: { message: { content: [{ type: "text", text: `Ledger settlement turn ${turn}: the reconciliation pipeline compares invariants.` }] } },
    });
    events.push({
      seq: events.length,
      type: "tool/call",
      data: { name: "read_file", arguments: JSON.stringify({ path: `src/ledger/${turn}.js`, limit: 40 }) },
    });
  }
  engine.captureSessionEvents({ session: { id: sessionId, events: events.slice(0, 9) } });
  engine.captureSessionEvents({ session: { id: sessionId, events } });

  // The live surface exactly as `deriveMessages()` would hand it to lib/index.js,
  // tool-call blocks included.
  const live = [];
  for (const event of events) {
    if (event.type === "user/message") live.push({ role: "user", content: event.data.content });
    else if (event.type === "assistant/message") live.push({ role: "assistant", content: event.data.message.content });
    else if (event.type === "tool/call") {
      live.push({ role: "assistant", content: [{ type: "tool-call", name: event.data.name, arguments: event.data.arguments }] });
    }
  }
  const base = { query: "ledger settlement reconciliation pipeline", maxTokens: 2400, reservedOutputTokens: 400, scope: sessionId };

  // Without the fix, presence would not read the tool-call blocks and the
  // captured tool/call chunks would be re-injected. Reproduce that state to
  // prove the assertion below is not vacuous.
  const textOnlySurface = live.map((message) => ({
    role: message.role,
    content: Array.isArray(message.content) ? message.content.filter((block) => block?.type === "text") : message.content,
  }));
  const wouldReinject = engine.buildContext({ ...base, presence: buildPresenceIndex(textOnlySurface) });
  const toolCallItemsInBugState = wouldReinject.sections
    .flatMap((section) => section.items)
    .filter((item) => /tool-call/.test(item.chunk.id));
  assert.ok(toolCallItemsInBugState.length > 0, "the bug state must actually re-inject tool-call chunks");

  // With tool-call blocks in the surface, they are duplication and go.
  const window = engine.buildContext({ ...base, presence: buildPresenceIndex(live) });
  const surface = live.map((message) => canonical(liveText(message))).filter(Boolean).join("\n");
  const items = window.sections.flatMap((section) => section.items);
  const duplicated = items.filter((item) => {
    const body = storedBody(item.chunk.content);
    return body !== "" && surface.includes(body);
  });
  const totalTokens = items.reduce((sum, item) => sum + item.chunk.tokens, 0);
  const dupTokens = duplicated.reduce((sum, item) => sum + item.chunk.tokens, 0);

  assert.equal(window.text, "", "every captured chunk is already on the live surface");
  assert.equal(items.length, 0);
  assert.equal(dupTokens, 0, "no tool-call-sourced duplication may survive");
  assert.equal(totalTokens === 0 ? 0 : dupTokens / totalTokens, 0);
  assert.ok(window.report().dupDroppedCount >= 6, "the tool-call chunks must be counted as dropped");
});

test("R-001 engine: a short-token chunk is injected while genuinely duplicated text is dropped", () => {
  const engine = new LocalContextEngine();
  engine.addChunks([
    // Preference chunks are always included, so this one reaches the filter
    // regardless of the query — and its body is only "ok".
    new Chunk({ id: "short-token", source: "user-short.md", kind: SourceKind.PREFERENCE, content: "ok" }),
    new Chunk({
      id: "genuine-duplicate",
      source: "runbook.md",
      kind: SourceKind.FILE,
      content: "the token budget must be respected in every assembly",
    }),
  ]);
  const presence = buildPresenceIndex([
    { role: "user", content: [{ type: "text", text: "the token budget must be respected in every assembly of the request" }] },
  ]);

  // "ok" occurs inside "token", but that is not what the request says.
  assert.equal(presence.contains("ok"), false);

  const window = engine.buildContext({
    query: "token budget assembly",
    maxTokens: 600,
    reservedOutputTokens: 100,
    presence,
  });
  const ids = window.report().sections.flatMap((section) => section.items.map((item) => item.id));
  assert.equal(ids.includes("short-token"), true, "a short-token chunk must never be withheld on an in-word hit");
  assert.equal(ids.includes("genuine-duplicate"), false, "text the request really carries is still dropped");
});

// ---------------------------------------------------------------------------
// 2c. R-003: ONE tool-call spelling across both capture paths and presence
// ---------------------------------------------------------------------------

test("R-003: both capture spellings and presence use the same tool-call text", () => {
  const invocation = { name: "read_file", arguments: '{"path":"src/ledger/3.js"}' };
  const expected = toolCallText(invocation);
  assert.equal(expected, '[tool/call read_file] {"path":"src/ledger/3.js"}');

  // Message path: an assistant message's block array.
  assert.equal(
    blocksToText([{ type: "text", text: "looking" }, { type: "tool-call", ...invocation }]),
    `looking\n${expected}`,
    "blocksToText must spell a message tool-call block exactly as presence does",
  );
  // Event path: describeEvent's tool/call chunk.
  assert.equal(describeEvent({ seq: 1, type: "tool/call", data: invocation }, "s").content, expected);

  // Presence reads the live block as that same string.
  const live = [{ role: "assistant", content: [{ type: "tool-call", id: "call_1", ...invocation }] }];
  assert.equal(buildPresenceIndex(live).contains(expected), true);
  // And a chunk from the old hyphen spelling is not what the request carries.
  assert.equal(buildPresenceIndex(live).contains("[tool-call read_file]"), false);
});

test("R-003: a chunk captured from an assistant message carrying a tool-call block is not re-injected", () => {
  const engine = new LocalContextEngine();
  const sessionId = "assistant-toolcall";
  const invocation = { type: "tool-call", id: "call_1", name: "read_file", arguments: '{"path":"src/ledger/7.js"}' };
  const assistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "I will read the ledger file for reconciliation" }, invocation],
  };
  const events = [
    {
      seq: 0,
      type: "user/message",
      data: { role: "user", content: [{ type: "text", text: "read the ledger file for reconciliation" }] },
    },
    { seq: 1, type: "assistant/message", data: { message: assistantMessage } },
  ];
  engine.captureSessionEvents({ session: { id: sessionId, events } });

  // The message path really did store the block, in the shared spelling.
  const toolChunk = engine.index.allChunks().find((chunk) => chunk.content.includes("[tool/call read_file]"));
  assert.ok(toolChunk, "the assistant message's tool-call block must be captured");
  assert.equal(toolChunk.content.includes("[tool-call read_file]"), false, "the hyphen spelling must be gone");

  // Derive the live surface the way the plugin does, then dedupe.
  const live = [{ role: "user", content: events[0].data.content }, assistantMessage];
  const presence = buildPresenceIndex(live);
  assert.equal(presence.contains(toolChunk.content), true, "the message-sourced chunk must match its live block");

  const window = engine.buildContext({
    query: "read the ledger file for reconciliation",
    maxTokens: 800,
    reservedOutputTokens: 200,
    scope: sessionId,
    presence,
  });
  assert.equal(window.text, "", "both captured chunks are already on the live surface");
  assert.ok(window.report().dupDroppedCount >= 2, "the tool-call-bearing message chunk must be counted as dropped");
});

// ---------------------------------------------------------------------------
// 2d. R-004: measuring the saving costs nothing, and is opt-in
// ---------------------------------------------------------------------------

test("R-004: measureSavings defaults to false and runs no second assembly", () => {
  const { engine, presence } = presenceEngine();
  let assemblies = 0;
  const real = engine.buildContext.bind(engine);
  engine.buildContext = (options) => {
    assemblies += 1;
    return real(options);
  };

  const off = engine.buildContext({ ...BUDGET, presence });
  assert.equal(assemblies, 1, "the default path must not run a second full assembly");
  assert.equal(off.dupSavedTokens, 0, "not measured must read 0, not a wrong number");
  assert.ok(off.dupCandidateTokens > 0, "the pool is still reported without measuring");

  assemblies = 0;
  const on = engine.buildContext({ ...BUDGET, presence, measureSavings: true });
  assert.equal(assemblies, 2, "the explicit diagnostic opt-in is exactly one extra assembly");
  assert.ok(on.dupSavedTokens > 0, "the opt-in path reports the realised saving");

  engine.buildContext = real;
});

test("R-004: the counterfactual never calls the summarizer", async () => {
  const duplicate = "duplicate sentinel omega ".repeat(60); // ~345 tokens, top priority
  const base = { query: "sentinel omega detail", maxTokens: 260, reservedOutputTokens: 100 };

  /** One probe on a FRESH engine, so compression caches cannot mask a call. */
  const probe = async (measureSavings) => {
    const engine = new LocalContextEngine();
    engine.addChunks([
      new Chunk({ id: "dup", source: "dup.md", kind: SourceKind.FILE, content: duplicate, priority: 10 }),
      new Chunk({ id: "big-1", source: "a.md", kind: SourceKind.FILE, content: "alpha sentinel detail ".repeat(60) }),
      new Chunk({ id: "small-1", source: "c.md", kind: SourceKind.FILE, content: "small sentinel alpha note about the reconciliation pipeline ".repeat(3) }),
    ]);
    let calls = 0;
    const window = await engine.buildContextAsync({
      ...base,
      presence: buildPresenceIndex([{ role: "user", content: duplicate }]),
      summarizer: async () => {
        calls += 1;
        return "";
      },
      measureSavings,
    });
    return { calls, window };
  };

  const without = await probe(false);
  const withMeasurement = await probe(true);

  // The fixture must actually exercise the summarizer, or equality proves nothing.
  assert.ok(without.calls >= 1, `the fixture must summarize at least once, saw ${without.calls}`);
  assert.equal(without.window.dupSavedTokens, 0);
  assert.ok(withMeasurement.window.dupSavedTokens > 0, "the opt-in measurement must report a real saving");

  // Zero calls attributable to measurement: the control assembly forces
  // summarizer: null, so enabling measurement cannot change the count.
  assert.equal(
    withMeasurement.calls,
    without.calls,
    `measurement added ${withMeasurement.calls - without.calls} summarizer call(s)`,
  );
});

// ---------------------------------------------------------------------------
// 3. Compaction: the same chunk is injected or not, decided by the live surface
// ---------------------------------------------------------------------------

test("compaction both directions: absent from the live window is injected, present is not", () => {
  const engine = new LocalContextEngine();
  // One indexed history chunk: memory the index keeps forever.
  engine.addChunks([
    new Chunk({
      id: "hist-vault",
      source: "session:compact-session",
      kind: SourceKind.HISTORY,
      content: "user: the vault key rotates every ninety days on the blue release flag",
      metadata: { sessionId: "compact-session" },
    }),
  ]);
  const query = "vault key rotates ninety days";
  const base = { query, maxTokens: 400, reservedOutputTokens: 100, scope: "compact-session" };

  // A compaction `replace` removed the message from the surface: the request no
  // longer carries it, so it IS injected — this is the requirement that a
  // "history off by default" implementation silently loses.
  const compacted = engine.buildContext({ ...base, presence: buildPresenceIndex([]) });
  assert.match(compacted.text, /vault key rotates every ninety days/, "history compaction removed must come back");
  assert.equal(compacted.report().dupDroppedCount, 0);

  // The same message is still in the live surface: the request already carries
  // it, so it is NOT injected.
  const live = buildPresenceIndex([
    { role: "assistant", content: [{ type: "text", text: "the vault key rotates every ninety days on the blue release flag" }] },
  ]);
  const alreadyThere = engine.buildContext({ ...base, presence: live });
  assert.equal(alreadyThere.text, "", "history the request already carries is not restated");
  assert.equal(alreadyThere.report().dupDroppedCount, 1);

  // And the contrast is not "history is always off": with a live surface that
  // holds something else entirely, the compacted history still comes back.
  const unrelated = buildContextWith(engine, base, [{ role: "user", content: "unrelated live message" }]);
  assert.match(unrelated.text, /vault key rotates every ninety days/);
});

/** Build a window for one explicit live surface. */
function buildContextWith(engine, base, messages) {
  return engine.buildContext({ ...base, presence: buildPresenceIndex(messages) });
}

// ---------------------------------------------------------------------------
// 4. The prompt-context path: capability-probed `deriveMessages()`
// ---------------------------------------------------------------------------

/** Minimum host surface `apply` touches, with a prompt-context recorder. */
function makeHost() {
  const contexts = new Map();
  const tools = [];
  const listeners = {};
  const host = {
    tools: { register: (definition) => (tools.push(definition), () => {}) },
    workspaceRegistry: { resolveByPath: async (path) => ({ path }) },
    webServer: { register: () => () => {} },
    systemPrompt: { context: (contribution) => (contexts.set(contribution.name, contribution), () => {}) },
    on: (event, listener) => ((listeners[event] ??= []).push(listener), () => {}),
  };
  return { host, contexts, tools, listeners };
}

/** One DSH-shaped session whose live surface the test controls. */
function makeSession(id, cwd, text) {
  return {
    id,
    header: { cwd },
    events: [
      { seq: 1, time: Date.now(), type: "user/message", data: { role: "user", content: [{ type: "text", text }] } },
    ],
  };
}

test("prompt-context reads deriveMessages() behind capability probing and degrades when absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lce-presence-plugin-"));
  const { host, contexts, tools } = makeHost();
  apply(host, { backend: "sqlite", defaultIndex: ".lce/index.db", autoIndexFiles: false, fileWatch: false });
  const contribution = contexts.get(PROMPT_CONTEXT_NAME);
  assert.ok(contribution, "autoInject registers the prompt context");

  // Project material the request does not carry, ingested through the plugin's
  // own engine so the contribution sees it.
  const prefPath = join(dir, "preference.md");
  writeFileSync(prefPath, "Prefer concise local-first answers about vault rotation.", "utf8");
  const ingest = tools.find((tool) => tool.name === "context_prism_ingest");
  await ingest.execute({ path: prefPath, kind: "preference" }, { agent: { session: { header: { cwd: dir } } } });

  const message = "the vault key rotates every ninety days";
  const session = makeSession("probe-session", dir, message);
  const agent = { id: session.id, session };

  // (a) Host without the method: conservative degrade — behave as though the
  // request held no conversation, so everything stays injectable.
  const missesBefore = diagnostics.presence.misses;
  const noCapability = await contribution.text({ agent });
  assert.match(noCapability, /vault key rotates every ninety days/, "no deriveMessages must not lose history");
  assert.match(noCapability, /concise local-first/, "project material is injected");
  assert.equal(diagnostics.presence.source, "none");
  assert.equal(diagnostics.presence.misses, missesBefore + 1);

  // (b) A probing call must survive a throwing projection rather than fail the
  // whole assembly.
  session.deriveMessages = () => {
    throw new Error("projection unavailable");
  };
  const throwing = await contribution.text({ agent });
  assert.match(throwing, /vault key rotates every ninety days/, "a rejecting projection degrades, never throws");
  assert.equal(diagnostics.presence.source, "none");

  // (c) The live surface carries the message: history is not restated, while
  // the preference (absent from the request) still is.
  session.deriveMessages = () => [{ role: "user", content: [{ type: "text", text: message }] }];
  const deduped = await contribution.text({ agent });
  assert.equal(diagnostics.presence.source, "session.deriveMessages");
  assert.equal(diagnostics.presence.messages, 1);
  // R-002: the reported character count covers what presence actually read
  // (`chars`), while `haystackChars` is its cap-limited portion. One message
  // means nothing overflowed, so the two agree and both are non-zero.
  assert.equal(diagnostics.presence.capped, false);
  assert.equal(diagnostics.presence.chars, message.length);
  assert.equal(diagnostics.presence.haystackChars, diagnostics.presence.chars);
  assert.equal(deduped.includes("vault key rotates every ninety days"), false, "history the request carries is dropped");
  assert.match(deduped, /concise local-first/, "project material is still injected");

  // F2 on the shipping surface: it publishes the realised saving under a name
  // that says "saving", and the candidate-pool number under a name that says
  // "candidate" — never the pool aliased as savings.
  assert.equal(typeof diagnostics.lastInjection.dupSavedTokens, "number");
  assert.equal(typeof diagnostics.lastInjection.dupCandidateTokens, "number");
  // R-004: the hot path does not measure. A drop really happened (count > 0)
  // yet the saving reads 0, the honest "not measured" value — the prompt path
  // must not pay a second assembly for a number only a report reader wants.
  assert.ok(diagnostics.lastInjection.dupDroppedCount >= 1, "the filter did drop something");
  assert.equal(diagnostics.lastInjection.dupSavedTokens, 0, "the hot path must not measure savings");
  assert.equal(
    Object.prototype.hasOwnProperty.call(diagnostics.lastInjection, "dupDroppedTokens"),
    false,
    "the legacy pool alias must not reach the shipping diagnostics",
  );

  // (d) Surface that also carries the preference: nothing is left to say.
  session.deriveMessages = () => [
    { role: "user", content: [{ type: "text", text: message }] },
    { role: "system", content: "Prefer concise local-first answers about vault rotation." },
  ];
  const nothing = await contribution.text({ agent });
  assert.equal(nothing, "", "the whole contribution collapses to empty when everything is already present");
});

test("prompt-context restores history a compaction removed from the live surface", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lce-presence-compact-"));
  const { host, contexts } = makeHost();
  apply(host, { backend: "sqlite", defaultIndex: ".lce/index.db", autoIndexFiles: false, fileWatch: false });
  const contribution = contexts.get(PROMPT_CONTEXT_NAME);

  const message = "the archive retention policy keeps seven years of audit records";
  const session = makeSession("compacted-session", dir, message);
  const agent = { id: session.id, session };

  // Step 1 captures the message into the index.
  session.deriveMessages = () => [];
  const captured = await contribution.text({ agent });
  assert.match(captured, /archive retention policy/, "a compacted-away message is injected");

  // Step 2: the surface still omits it (the compaction replaced it), so the
  // index's copy is the only place the model can get it back.
  session.deriveMessages = () => [{ role: "assistant", content: [{ type: "text", text: "Understood." }] }];
  const restored = await contribution.text({ agent });
  assert.match(restored, /seven years of audit records/, "still absent from the request, still injected");

  // Step 3: the message is back on the live surface, so it is not restated.
  session.deriveMessages = () => [{ role: "user", content: [{ type: "text", text: message }] }];
  const deduped = await contribution.text({ agent });
  assert.equal(deduped.includes("seven years of audit records"), false);
});

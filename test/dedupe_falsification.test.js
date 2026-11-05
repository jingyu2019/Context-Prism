// Independent falsification of presence-aware injection (v0.10, task t2).
//
// t1 claims two things at once:
//   (a) the prompt contribution no longer re-states text the outgoing request
//       already carries, and
//   (b) it still injects text the request does NOT carry — project material, and
//       history a compaction `replace` removed from the live surface.
//
// A change that saves tokens by dropping needed information is a regression; a
// change that keeps information by injecting everything saves nothing. This file
// is written to catch BOTH failure modes, and every assertion it relies on has
// been shown to go red when the mechanism is removed (see the /tmp probes
// reported with this task).
//
// Measurement independence: `measureWindow` below is written from the window's
// report shape (sections -> items -> chunk tokens) and its own text
// normalisation. It deliberately does NOT import `engine/presence.js`, and it
// never reads `dupDroppedCount` / `dupDroppedTokens` to decide what is a
// duplicate: the implementation's own counters are only cross-checked against
// the independent count afterwards. A verifier that reuses the mechanism to
// grade the mechanism proves nothing.
//
// Token accounting: the window item is a `RetrievedItem`, whose token count is
// `item.chunk.tokens` (there is no `item.tokens`; reading that field yields 0
// and makes every fraction fiction). The tests below reconcile
// `sum(chunk.tokens) + packing separators` against `section.tokens` and
// `window.totalTokens` before trusting any number.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Chunk, SourceKind, estimateTokens, isVisibleInScope } from "../engine/models.js";
import { LocalContextEngine } from "../engine/engine.js";
import { buildPresenceIndex } from "../engine/presence.js";
import { PROMPT_CONTEXT_NAME, Config, apply, diagnostics } from "../lib/index.js";

// ---------------------------------------------------------------------------
// 1. Measurement primitives (independent of the mechanism under test)
// ---------------------------------------------------------------------------

/** Whispace/case canonical form used on BOTH sides of every comparison. */
function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** `[kind | source]` / `[tool/call name]` / `[tool/result]` decoration capture adds. */
const STORED_HEADER = /^(?:\[[^\]\n]{0,120}\][ \t]*)+/;
/** `user:` / `assistant:` author label capture adds. */
const STORED_LABEL = /^(?:user|assistant|developer|system|tool|tool\/result)[ \t]*:[ \t]*/;

/**
 * The text of an indexed chunk with the plugin's own storage decoration
 * removed — i.e. the body a reader of the request would recognise.
 */
function storedBody(content) {
  const normalized = normalizeText(content);
  return normalizeText(normalized.replace(STORED_HEADER, "").replace(STORED_LABEL, ""));
}

/** Plain text of one live message; tool-call blocks only when asked for. */
function messageText(message, { toolCalls = false } = {}) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (toolCalls && block?.type === "tool-call") parts.push(`[tool/call ${block.name ?? ""}] ${block.arguments ?? ""}`);
  }
  return parts.join("\n");
}

/** One haystack per live surface: message texts, never across a message join. */
function surfaceText(messages, options) {
  return messages
    .map((message) => normalizeText(messageText(message, options)))
    .filter((text) => text !== "")
    .join("\n");
}

/**
 * Duplication of one context window against one live surface.
 *
 * An item duplicates when its stored body already appears in the surface the
 * request carries this step. Tokens are `chunk.tokens` (the field that exists),
 * and the section-weighted number is returned too so the caller can prove the
 * weighting is not an artefact of packing separators.
 *
 * `mixedSections` names sections holding both duplicate and non-duplicate items:
 * where that list is empty, the section-weighted fraction is exact, because a
 * section's rendered tokens are its items' tokens plus separators.
 */
function measureWindow(window, messages, { toolCalls = false } = {}) {
  const live = surfaceText(messages, { toolCalls });
  const sections = window.sections.map((section) => {
    const rows = section.items.map((item) => {
      const chunk = item.chunk;
      const tokens = Number.isFinite(chunk.tokens) && chunk.tokens > 0 ? chunk.tokens : estimateTokens(chunk.content);
      const body = storedBody(chunk.content);
      return { id: chunk.id, kind: chunk.kind, tokens, duplicate: body !== "" && live.includes(body) };
    });
    return {
      title: section.title,
      tokens: section.tokens,
      compressed: section.compressed,
      rows,
      itemTokens: rows.reduce((sum, row) => sum + row.tokens, 0),
    };
  });

  const items = sections.flatMap((section) => section.rows);
  const tokenTotal = items.reduce((sum, row) => sum + row.tokens, 0);
  const dupTokens = items.filter((row) => row.duplicate).reduce((sum, row) => sum + row.tokens, 0);

  const withItems = sections.filter((section) => section.rows.length > 0);
  const isAllDuplicate = (section) => section.rows.length > 0 && section.rows.every((row) => row.duplicate);
  const isNoDuplicate = (section) => section.rows.every((row) => !row.duplicate);
  const sectionTokens = withItems.reduce((sum, section) => sum + section.tokens, 0);
  const dupSectionTokens = withItems.filter(isAllDuplicate).reduce((sum, section) => sum + section.tokens, 0);

  return {
    items,
    ids: items.map((row) => row.id),
    tokens: tokenTotal,
    dupTokens,
    fraction: tokenTotal === 0 ? 0 : dupTokens / tokenTotal,
    sectionTokens,
    dupSectionTokens,
    sectionFraction: sectionTokens === 0 ? 0 : dupSectionTokens / sectionTokens,
    mixedSections: withItems.filter((section) => !isAllDuplicate(section) && !isNoDuplicate(section)).map((s) => s.title),
    sections,
  };
}

/**
 * Independently count every VISIBLE chunk whose body the request already holds.
 *
 * `dupDroppedTokens` counts the candidate pool, not the rendered window: an item
 * can be dropped from the pool even though the budget would have omitted it
 * anyway. So the counter is cross-checked here against the pool itself (exact at
 * a step whose index fits the retrieval candidate window), and against the
 * realized saving separately.
 */
function duplicateCandidate(engine, sessionId, liveMessages) {
  const live = surfaceText(liveMessages);
  let tokens = 0;
  let count = 0;
  for (const chunk of engine.index.allChunks()) {
    if (!isVisibleInScope(chunk, sessionId)) continue;
    const body = storedBody(chunk.content);
    if (body !== "" && live.includes(body)) {
      tokens += chunk.tokens;
      count += 1;
    }
  }
  return { tokens, count };
}

/**
 * Reconcile the numbers this file reports against the window's own totals.
 *
 * Without this, a wrong token field silently reports 0 for every item and the
 * "fraction" becomes meaningless. `packedTokens(n) = 2 * (n - 1)` is the
 * separator cost `_renderPacked` pays between items.
 */
function assertAccounting(window, label) {
  let sectionSum = 0;
  for (const section of window.sections) {
    sectionSum += section.tokens;
    const itemTokens = section.items.reduce(
      (sum, item) => sum + (item.chunk.tokens > 0 ? item.chunk.tokens : estimateTokens(item.chunk.content)),
      0,
    );
    const separators = section.items.length > 1 ? 2 * (section.items.length - 1) : 0;
    if (section.compressed) {
      assert.ok(
        section.tokens > 0 && section.tokens <= itemTokens + separators,
        `${label}: compressed section "${section.title}" must cost no more than its items (${section.tokens} <= ${itemTokens + separators})`,
      );
    } else {
      assert.equal(
        section.tokens,
        itemTokens + separators,
        `${label}: section "${section.title}" tokens must equal item tokens + separators`,
      );
    }
  }
  assert.equal(window.totalTokens, sectionSum, `${label}: window total must equal its sections`);

  // The rendered text is what the model reads: it may add section headers and
  // one `[kind | source]` label per item, but it can never carry materially
  // fewer tokens than the accounting claims, and it must not carry a second
  // window's worth that no section accounts for.
  const rendered = estimateTokens(window.text);
  let decorationRoom = 0;
  for (const section of window.sections) {
    decorationRoom += estimateTokens(`### ${section.title}`) + 2;
    for (const item of section.items) {
      const label = `[${item.chunk.kind} | ${item.chunk.metadata?.path || item.chunk.source}]`;
      decorationRoom += estimateTokens(label) + 2;
    }
  }
  assert.ok(rendered >= window.totalTokens, `${label}: rendered text (${rendered}) must cover totalTokens (${window.totalTokens})`);
  assert.ok(
    rendered <= window.totalTokens + decorationRoom + 8,
    `${label}: rendered text (${rendered}) must not exceed totalTokens + decorations (${window.totalTokens + decorationRoom + 8})`,
  );
}

// ---------------------------------------------------------------------------
// 2. A multi-turn coding session with tool results (captured, then assembled)
// ---------------------------------------------------------------------------

const SESSION_ID = "checkout-ledger-session";
const MAX_TOKENS = 4000;
const RESERVED_TOKENS = 1024;
const MEASURED_TURNS = 10;
/** The session has already run for this many turns before we start measuring. */
const WARMUP_TURNS = 5;
const TOTAL_TURNS = WARMUP_TURNS + MEASURED_TURNS;

/** A file excerpt a `read_file` tool produced, large enough to fill a budget. */
function toolOutput(turn) {
  const lines = [];
  for (let line = 1; line <= 24; line += 1) {
    lines.push(
      `  ledgerTurn${turn}Line${line}: retry attempt ${line} keeps the settlement cadence at ${turn * 100}ms ` +
        `and the ledger rounding rule at two decimals for the checkout path.`,
    );
  }
  return `export function settleLedgerTurn${turn}(attempt) {\n${lines.join("\n")}\n  return { ok: true };\n}`;
}

function userEvent(seq, turn) {
  return {
    seq,
    time: Date.now(),
    type: "user/message",
    data: {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `Turn ${turn}: in src/ledger/${turn}.js the settlement cadence changed. ` +
            `Confirm which release flag gates turn ${turn} and whether the ledger rounding rule still applies to the checkout path.`,
        },
      ],
    },
  };
}

function assistantEvent(seq, turn) {
  return {
    seq,
    time: Date.now(),
    type: "assistant/message",
    data: {
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text:
              `I read src/ledger/${turn}.js. Turn ${turn} is gated by the blue release flag; the ledger rounding rule ` +
              `keeps two decimals and the settlement cadence for the checkout path is ${turn * 100} milliseconds.`,
          },
        ],
      },
    },
  };
}

function toolCallEvent(seq, turn) {
  return {
    seq,
    time: Date.now(),
    type: "tool/call",
    data: { name: "read_file", arguments: JSON.stringify({ path: `src/ledger/${turn}.js` }) },
  };
}

function toolResultEvent(seq, turn) {
  return {
    seq,
    time: Date.now(),
    type: "tool/result",
    data: { message: { role: "tool", content: [{ type: "text", text: toolOutput(turn) }] } },
  };
}

/**
 * Build one coding session. `withToolCalls` adds the `read_file` calls; their
 * arguments are carried by the request as `tool-call` blocks, which is why they
 * matter to a "what does the prompt already hold" question.
 */
function buildSession({ turns = TOTAL_TURNS, withToolCalls = false } = {}) {
  const events = [];
  let seq = 0;
  for (let turn = 1; turn <= turns; turn += 1) {
    events.push(userEvent(seq++, turn));
    events.push(assistantEvent(seq++, turn));
    if (withToolCalls) events.push(toolCallEvent(seq++, turn));
    events.push(toolResultEvent(seq++, turn));
  }
  return { events, perTurn: withToolCalls ? 4 : 3 };
}

/** The messages the outgoing request carries, as `deriveMessages()` would give them. */
function messagesOf(events, { toolCalls = false } = {}) {
  const out = [];
  for (const event of events) {
    if (event.type === "user/message") out.push({ role: "user", content: event.data.content });
    else if (event.type === "assistant/message") out.push({ role: "assistant", content: event.data.message.content });
    else if (event.type === "tool/result") out.push({ role: "tool", content: event.data.message.content });
    else if (toolCalls && event.type === "tool/call") {
      out.push({
        role: "assistant",
        content: [{ type: "tool-call", name: event.data.name, arguments: event.data.arguments }],
      });
    }
  }
  return out;
}

function latestQuery(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === "user/message") {
      return events[index].data.content.map((block) => block.text ?? "").join("\n").trim();
    }
  }
  return "";
}

/**
 * The real assembly loop: one capture + two assemblies per step, the second one
 * exactly what `lib/index.js` does (presence from the live messages, dedupe on).
 *
 * `before` is the pre-v0.10 behaviour (`dedupeAgainstPrompt: false`), so the two
 * numbers in every row come from the same index, the same query and the same
 * budget: the only difference is the presence filter.
 */
function runSession({
  engine,
  sessionId,
  events,
  perTurn,
  fromTurn = 1,
  steps = MEASURED_TURNS,
  maxTokens = MAX_TOKENS,
  reservedOutputTokens = RESERVED_TOKENS,
}) {
  const rows = [];
  for (let turn = fromTurn; turn < fromTurn + steps; turn += 1) {
    const liveEvents = events.slice(0, turn * perTurn);
    engine.captureSessionEvents({ session: { id: sessionId, events: liveEvents }, cursor: engine.sessionCursor(sessionId) });

    const liveMessages = messagesOf(liveEvents);
    const presence = buildPresenceIndex(liveMessages);
    const query = latestQuery(liveEvents);
    const base = { query, maxTokens, reservedOutputTokens, scope: sessionId };

    const before = engine.buildContext({ ...base, presence, dedupeAgainstPrompt: false });
    const after = engine.buildContext({ ...base, presence });

    assertAccounting(before, `turn ${turn} before`);
    assertAccounting(after, `turn ${turn} after`);

    rows.push({
      turn,
      liveMessages,
      before,
      after,
      beforeMeasure: measureWindow(before, liveMessages),
      afterMeasure: measureWindow(after, liveMessages),
    });
  }
  return rows;
}

function totals(rows, key) {
  return rows.reduce(
    (sum, row) => ({
      tokens: sum.tokens + row[key].tokens,
      dupTokens: sum.dupTokens + row[key].dupTokens,
      steps: sum.steps + 1,
    }),
    { tokens: 0, dupTokens: 0, steps: 0 },
  );
}

function percent(part, whole, digits = 1) {
  if (whole === 0) return "0.0%";
  return `${((part / whole) * 100).toFixed(digits)}%`;
}

/** How many tokens of an already-captured message the request is carrying. */
function contentTokens(content) {
  return estimateTokens(content);
}

// ---------------------------------------------------------------------------
// 3. Project material the request does not carry (scenario B / requirement 3)
// ---------------------------------------------------------------------------

/** A small project corpus in a temp workspace: code, a runbook, a preference. */
function projectWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "cp-dedupe-falsify-"));
  mkdirSync(join(dir, "src/ledger"), { recursive: true });
  mkdirSync(join(dir, "docs"), { recursive: true });

  const pad = (label) => {
    const lines = [];
    for (let line = 1; line <= 18; line += 1) {
      lines.push(`// ${label} line ${line}: ledger settlement invariants, checked by the reconciliation suite.`);
    }
    return lines.join("\n");
  };

  writeFileSync(
    join(dir, "src/ledger/settle.js"),
    `${pad("settle")}
export const LEDGER_ROUNDING_DECIMALS = 2;

/** Post one ledger entry; the gold answer for "how is settlement rounded?". */
export function postLedgerEntry(amount, currency) {
  const scale = 10 ** LEDGER_ROUNDING_DECIMALS;
  return { currency, amount: Math.round(amount * scale) / scale, flag: "blue release flag" };
}
`,
    "utf8",
  );

  writeFileSync(
    join(dir, "docs/ledger-runbook.md"),
    `# Ledger settlement runbook

The settlement cadence is 900 milliseconds and ledger rounding keeps two decimals.
A failed settlement retries under the checkout path cap; the runbook owns the blue release flag decision.
${pad("runbook")}
`,
    "utf8",
  );

  return dir;
}

// ---------------------------------------------------------------------------
// 4. THE SAVING: measured duplication fraction, before and after
// ---------------------------------------------------------------------------

test("token accounting is trustworthy before any fraction is computed", () => {
  const engine = new LocalContextEngine();
  const { events, perTurn } = buildSession({ turns: 3 });
  engine.captureSessionEvents({ session: { id: "accounting", events } });
  const liveMessages = messagesOf(events.slice(0, 2 * perTurn));
  const window = engine.buildContext({
    query: latestQuery(events.slice(0, 2 * perTurn)),
    maxTokens: MAX_TOKENS,
    reservedOutputTokens: RESERVED_TOKENS,
    scope: "accounting",
    presence: buildPresenceIndex(liveMessages),
    dedupeAgainstPrompt: false,
  });

  // The real token field is `item.chunk.tokens`. A verifier that reads
  // `item.tokens` gets 0 for every item; this asserts the field exists and is
  // consistent with the section/window totals `assertAccounting` already checks.
  const itemTokens = window.sections.flatMap((section) => section.items).map((item) => item.chunk.tokens);
  assert.ok(itemTokens.length > 0);
  assert.equal(itemTokens.every((tokens) => Number.isFinite(tokens) && tokens > 0), true);
  assert.equal(
    window.sections.flatMap((section) => section.items).every((item) => item.tokens === undefined),
    true,
    "window items have no `tokens` field — reading it is the accounting bug this guards",
  );
  assert.ok(window.totalTokens > 0);
});

test("scenario A — no project material: the duplication fraction goes ~100% -> 0% over 10 steps", (t) => {
  const engine = new LocalContextEngine();
  const { events, perTurn } = buildSession({ turns: TOTAL_TURNS });
  const rows = runSession({ engine, sessionId: SESSION_ID, events, perTurn, fromTurn: WARMUP_TURNS + 1 });

  const before = totals(rows, "beforeMeasure");
  const after = totals(rows, "afterMeasure");
  const beforeFraction = before.dupTokens / before.tokens;
  const afterFraction = after.tokens === 0 ? 0 : after.dupTokens / after.tokens;

  const first = rows[0];
  const last = rows.at(-1);
  t.diagnostic(
    `scenario A: ${rows.length} assembly steps over a ${TOTAL_TURNS}-turn session (no project files indexed)`,
  );
  t.diagnostic(
    `before: ${before.tokens} item tokens injected (${before.dupTokens} duplicating = ${percent(before.dupTokens, before.tokens, 2)})`,
  );
  t.diagnostic(
    `after:  ${after.tokens} item tokens injected (${after.dupTokens} duplicating = ${percent(after.dupTokens, after.tokens, 2)})`,
  );
  t.diagnostic(`step 1:  before ${first.beforeMeasure.tokens} tok -> after ${first.afterMeasure.tokens} tok`);
  t.diagnostic(`step 10: before ${last.beforeMeasure.tokens} tok -> after ${last.afterMeasure.tokens} tok`);
  t.diagnostic(`baseline saving: ${before.tokens - after.tokens} item tokens over ${rows.length} steps`);

  // The baseline reproduces the shape the task measured: nearly every injected
  // token was a restatement of a message already in the prompt.
  assert.equal(
    rows.every((row) => row.beforeMeasure.dupTokens === row.beforeMeasure.tokens),
    true,
    "baseline: every injected item is a copy of a live message",
  );
  assert.ok(beforeFraction >= 0.99, `baseline duplication fraction must be ~100%, got ${percent(before.dupTokens, before.tokens, 2)}`);
  assert.ok(before.tokens > 5000, `baseline must inject a material amount, got ${before.tokens} tokens`);

  // After: the contribution is either empty (all present) or carries nothing
  // that the request already holds.
  assert.ok(afterFraction <= 0.02, `after duplication fraction must be near zero, got ${percent(after.dupTokens, after.tokens, 2)}`);
  assert.equal(after.dupTokens, 0, "after: no injected token may duplicate the live window");
  assert.equal(
    rows.every((row) => row.afterMeasure.dupTokens === 0),
    true,
    "after: every step, not just the total, must be duplicate-free",
  );
  // Scenario A collapses to an empty contribution: the request already has all
  // of it, so saying nothing is the correct answer.
  assert.equal(after.tokens, 0, "after: with no project material there is nothing left worth injecting");
  assert.equal(
    rows.every((row) => row.after.text === ""),
    true,
    "after: the whole contribution collapses to empty on every step",
  );

  // Accounting cross-check. `dupDroppedTokens` counts the CANDIDATE POOL the
  // filter removed, not only the items the budget would have rendered, so it is
  // legitimately larger than the realized saving. At the first measured step the
  // whole index fits the retrieval candidate window, so the pool is knowable
  // independently and the counter must match it exactly.
  const firstStepCandidates = duplicateCandidate(engine, SESSION_ID, rows[0].liveMessages);
  assert.equal(
    rows[0].after.dupDroppedTokens,
    firstStepCandidates.tokens,
    "step 1: dupDroppedTokens must equal the independently counted candidate pool",
  );
  const reportedDropped = rows.reduce((sum, row) => sum + row.after.dupDroppedTokens, 0);
  const realizedSaving = before.tokens - after.tokens;
  t.diagnostic(
    `realized saving ${realizedSaving} tokens; candidate-pool drop counter ${reportedDropped} tokens (it also counts material the budget would have omitted)`,
  );
  assert.ok(reportedDropped >= realizedSaving, "the drop counter must cover at least the realized saving");
  assert.equal(realizedSaving, before.tokens, "scenario A realizes the entire baseline as a saving");
});

test("scenario B — with project material: the window stays populated with NON-duplicate material", (t) => {
  const engine = new LocalContextEngine();
  const workspace = projectWorkspace();
  engine.addFile(join(workspace, "src/ledger/settle.js"), SourceKind.CODE);
  engine.addFile(join(workspace, "docs/ledger-runbook.md"), SourceKind.FILE);
  engine.addChunk(
    new Chunk({
      id: "pref-ledger-rounding",
      source: "user.md",
      kind: SourceKind.PREFERENCE,
      content: "Prefer concise local-first answers about ledger settlement rounding.",
      priority: 2,
    }),
  );

  const { events, perTurn } = buildSession({ turns: TOTAL_TURNS });
  const rows = runSession({ engine, sessionId: SESSION_ID, events, perTurn, fromTurn: WARMUP_TURNS + 1 });

  const before = totals(rows, "beforeMeasure");
  const after = totals(rows, "afterMeasure");
  const beforeFraction = before.dupTokens / before.tokens;
  const afterFraction = after.tokens === 0 ? 0 : after.dupTokens / after.tokens;

  t.diagnostic("scenario B: same 10 steps, with a ledger code file, a runbook and a preference indexed");
  t.diagnostic(
    `before: ${before.tokens} item tokens (${before.dupTokens} duplicating = ${percent(before.dupTokens, before.tokens, 2)})`,
  );
  t.diagnostic(
    `after:  ${after.tokens} item tokens (${after.dupTokens} duplicating = ${percent(after.dupTokens, after.tokens, 2)})`,
  );
  t.diagnostic(`after kinds per step: ${JSON.stringify(rows[0].afterMeasure.items.map((row) => row.kind))}`);
  t.diagnostic(`after ids per step: ${JSON.stringify(rows[0].afterMeasure.ids)}`);

  // Same baseline shape: the pre-change window is dominated by history copies.
  assert.ok(beforeFraction >= 0.6, `baseline duplication fraction must be high, got ${percent(before.dupTokens, before.tokens, 2)}`);
  assert.ok(before.tokens > after.tokens, "the baseline spent most of its tokens on duplicated history");

  // The after window is NOT empty: this is what kills a blanket "drop all
  // history" implementation, which would also score a 0% duplication fraction.
  assert.ok(after.tokens > 0, "after: project material must still reach the window");
  assert.equal(after.dupTokens, 0, "after: nothing injected may already be in the request");
  assert.ok(afterFraction <= 0.02, `after duplication fraction must be near zero, got ${percent(after.dupTokens, after.tokens, 2)}`);

  // Every step keeps a non-empty, duplicate-free window: the drop is not a
  // first-step artefact, and the empty-window collapse is confined to scenario A.
  for (const row of rows) {
    assert.ok(row.afterMeasure.tokens > 0, `turn ${row.turn}: after window must not be empty`);
    assert.ok(row.afterMeasure.items.length > 0, `turn ${row.turn}: after window must carry items`);
    assert.equal(row.afterMeasure.dupTokens, 0, `turn ${row.turn}: nothing in the after window may be a duplicate`);
    // The history section is gone because every history chunk is live.
    assert.equal(row.after.text.includes("blue release flag; the ledger rounding rule keeps two decimals"), false);
  }

  // Retention, stated against the baseline rather than against retrieval luck:
  // the pre-change window spent its budget on history and starved the project
  // corpus; the after window must give the corpus at least what the baseline
  // gave it, and in fact more (the freed budget goes to the survivors).
  const beforeNonDuplicate = before.tokens - before.dupTokens;
  assert.ok(
    after.tokens > beforeNonDuplicate,
    `project material must keep at least the baseline's share: after ${after.tokens} vs baseline non-duplicate ${beforeNonDuplicate}`,
  );
  t.diagnostic(`project material in the window: baseline ${beforeNonDuplicate} tok -> after ${after.tokens} tok`);

  // Every project kind reaches the window at least once, and the gold answers
  // for the query are present.
  const kinds = new Set(rows.flatMap((row) => row.afterMeasure.items.map((item) => item.kind)));
  assert.equal(kinds.has(SourceKind.CODE), true, "project code must survive filtering");
  assert.equal(kinds.has(SourceKind.FILE), true, "the runbook file must survive filtering");
  assert.equal(kinds.has(SourceKind.PREFERENCE), true, "the preference must survive filtering");
  assert.ok(
    rows.filter((row) => row.after.text.includes("postLedgerEntry")).length >= rows.length / 2,
    "the gold code answer must be injected on most steps",
  );
  assert.ok(
    rows.some((row) => row.after.text.includes("The settlement cadence is 900 milliseconds")),
    "the runbook gold answer must be injected",
  );

  // Section-weighted fraction cross-check: where no section mixes duplicate and
  // non-duplicate items, the two weightings must agree (separator noise only).
  const measured = rows.flatMap((row) => [row.beforeMeasure, row.afterMeasure]);
  assert.equal(
    measured.every((measure) => measure.mixedSections.length === 0),
    true,
    `no section may mix duplicate and non-duplicate items: ${JSON.stringify(measured.flatMap((m) => m.mixedSections))}`,
  );
  for (const measure of measured) {
    assert.ok(
      Math.abs(measure.fraction - measure.sectionFraction) <= 0.05,
      `item-weighted (${measure.fraction.toFixed(3)}) and section-weighted (${measure.sectionFraction.toFixed(3)}) fractions must agree`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. THE RETENTION: compaction replace, both directions (requirement 2)
// ---------------------------------------------------------------------------

/** The risky chunk: captured into the index, then removed from the surface. */
const COMPACTED_MESSAGE = "the archive retention policy keeps seven years of audit records";

test("compaction replace: absent from the live window IS injected; present is NOT", (t) => {
  const engine = new LocalContextEngine();
  const workspace = mkdtempSync(join(tmpdir(), "cp-dedupe-compact-"));
  const sessionId = "compacted-session";

  // Step 1: the message is on the surface; capture stores it.
  const firstTurn = [
    { seq: 0, time: Date.now(), type: "user/message", data: { role: "user", content: [{ type: "text", text: COMPACTED_MESSAGE }] } },
  ];
  engine.captureSessionEvents({ session: { id: sessionId, events: firstTurn } });
  assert.ok(engine.lastSessionChunk(sessionId), "the message must be captured into the index");

  const base = {
    query: "archive retention policy audit records",
    maxTokens: 1200,
    reservedOutputTokens: 200,
    scope: sessionId,
  };

  // Step 2: a compaction `replace` deleted the message. The request no longer
  // carries it, so the index's copy is the ONLY way the model can still see it.
  const compactedAway = engine.buildContext({ ...base, presence: buildPresenceIndex([]) });
  const absent = measureWindow(compactedAway, []);
  t.diagnostic(
    `absent-from-surface: ${absent.tokens} tokens, ${absent.dupTokens} duplicating, injected=${compactedAway.text.includes(COMPACTED_MESSAGE)}`,
  );
  assert.equal(compactedAway.text.includes(COMPACTED_MESSAGE), true, "a compaction-replaced message MUST be injected");
  assert.equal(compactedAway.dupDroppedCount, 0, "nothing is present, so nothing may be dropped");

  // Step 3: the very same message is back on the live surface. Now the request
  // already carries it, so re-injecting it is the waste this change removes.
  const live = [{ role: "user", content: [{ type: "text", text: COMPACTED_MESSAGE }] }];
  const presentContext = engine.buildContext({ ...base, presence: buildPresenceIndex(live) });
  const present = measureWindow(presentContext, live);
  t.diagnostic(
    `present-in-surface: ${present.tokens} tokens, ${present.dupTokens} duplicating, injected=${presentContext.text.includes(COMPACTED_MESSAGE)}`,
  );
  assert.equal(presentContext.text.includes(COMPACTED_MESSAGE), false, "a message the request carries MUST NOT be restated");
  assert.equal(present.dupTokens, 0);
  assert.equal(presentContext.dupDroppedCount, 1, "the captured message was dropped exactly once");

  // And the contrast is not "history is off": a surface holding something else
  // entirely still gets the compacted message back.
  const unrelated = [{ role: "assistant", content: [{ type: "text", text: "Understood, moving on." }] }];
  const unrelatedContext = engine.buildContext({ ...base, presence: buildPresenceIndex(unrelated) });
  assert.equal(unrelatedContext.text.includes(COMPACTED_MESSAGE), true, "an unrelated live surface must not suppress it");
});

test("a stored message is injected only when the LIVE surface lacks it (not when the index lacks it)", (t) => {
  const engine = new LocalContextEngine();
  const sessionId = "two-sided";
  const message = "the vault key rotates every ninety days on the blue release flag";
  engine.addChunk(
    new Chunk({
      id: "hist-vault",
      source: `session:${sessionId}`,
      kind: SourceKind.HISTORY,
      content: `user: ${message}`,
      metadata: { sessionId },
    }),
  );
  const base = { query: "vault key rotates ninety days blue release flag", maxTokens: 800, reservedOutputTokens: 200, scope: sessionId };
  const live = [{ role: "user", content: [{ type: "text", text: message }] }];

  const withSurface = engine.buildContext({ ...base, presence: buildPresenceIndex(live) });
  const withoutSurface = engine.buildContext({ ...base, presence: buildPresenceIndex([]) });
  t.diagnostic(
    `with live surface: ${withSurface.totalTokens} tokens, dropped=${withSurface.dupDroppedCount}; without: ${withoutSurface.totalTokens} tokens`,
  );
  assert.equal(withSurface.text.includes(message), false);
  assert.equal(withSurface.dupDroppedCount, 1);
  assert.equal(withoutSurface.text.includes(message), true);
  assert.equal(withoutSurface.dupDroppedCount, 0);

  // Same index, same query, opposite outcome: the decision comes from the live
  // surface. If it came from the index, both runs would agree.
  assert.notEqual(withSurface.text, withoutSurface.text);
});

// ---------------------------------------------------------------------------
// 6. Requirement 3: the filter is not a blanket — project material survives
// ---------------------------------------------------------------------------

test("project material absent from the request survives filtering and reaches the window", (t) => {
  const engine = new LocalContextEngine();
  const workspace = projectWorkspace();
  engine.addFile(join(workspace, "src/ledger/settle.js"), SourceKind.CODE);
  engine.addFile(join(workspace, "docs/ledger-runbook.md"), SourceKind.FILE);
  engine.addChunk(
    new Chunk({
      id: "pref-brevity",
      source: "user.md",
      kind: SourceKind.PREFERENCE,
      content: "Prefer concise local-first answers about ledger settlement rounding.",
    }),
  );
  // A live surface that is genuinely non-empty, so the filter is active rather
  // than short-circuited by an empty presence index.
  const live = [
    { role: "user", content: [{ type: "text", text: "turn 7 is gated by the blue release flag; the ledger rounding rule keeps two decimals" }] },
  ];
  const window = engine.buildContext({
    query: "ledger settlement rounding release flag checkout path",
    maxTokens: 2400,
    reservedOutputTokens: 400,
    presence: buildPresenceIndex(live),
  });
  const measure = measureWindow(window, live);
  assertAccounting(window, "project material");

  t.diagnostic(`project material: ${measure.tokens} tokens, kinds=${JSON.stringify([...new Set(measure.items.map((row) => row.kind))])}`);
  assert.ok(measure.items.length >= 3, "code, runbook and preference must all be present");
  assert.equal(measure.dupTokens, 0, "project material is absent from the request: nothing here duplicates it");
  assert.equal(window.text.includes("postLedgerEntry"), true, "the code chunk must reach the window");
  assert.equal(window.text.includes("The settlement cadence is 900 milliseconds"), true, "the runbook must reach the window");
  assert.equal(window.text.includes("concise local-first"), true, "the preference must reach the window");

  // And it survives with the wrong query too: filtering is not retrieval-luck.
  const unrelated = engine.buildContext({ query: "ledger", maxTokens: 2400, reservedOutputTokens: 400, presence: buildPresenceIndex(live) });
  assert.ok(unrelated.text.includes("postLedgerEntry") || unrelated.text.includes("settlement cadence"));
});

// ---------------------------------------------------------------------------
// 7. Requirement 5: host degradation without `deriveMessages()`
// ---------------------------------------------------------------------------

/** Minimum host surface `apply` touches, with a prompt-context recorder. */
function makeHost() {
  const contexts = new Map();
  const tools = [];
  const host = {
    tools: { register: (definition) => (tools.push(definition), () => {}) },
    workspaceRegistry: { resolveByPath: async (path) => ({ path }) },
    webServer: { register: () => () => {} },
    systemPrompt: { context: (contribution) => (contexts.set(contribution.name, contribution), () => {}) },
    on: () => () => {},
  };
  return { host, contexts, tools };
}

function sessionWith(id, cwd, texts) {
  let seq = 0;
  return {
    id,
    header: { cwd },
    events: texts.map(({ role, text }) => {
      if (role === "user") {
        return { seq: seq++, time: Date.now(), type: "user/message", data: { role: "user", content: [{ type: "text", text }] } };
      }
      return {
        seq: seq++,
        time: Date.now(),
        type: "assistant/message",
        data: { message: { role: "assistant", content: [{ type: "text", text }] } },
      };
    }),
  };
}

/** The item paragraphs of a rendered contribution (independent of the engine). */
function contributionParagraphs(text) {
  return text
    .split("\n\n")
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "")
    // The rendered contribution header and the "N items omitted" note are
    // bookkeeping, not injected index content: counting them would inflate the
    // non-duplicate side of the fraction.
    .filter((paragraph) => !paragraph.startsWith("[ContextPrism]"))
    .filter((paragraph) => !/^### Omitted Memory\b/.test(paragraph))
    .map((paragraph) =>
      paragraph
        .split("\n")
        .filter((line) => !/^### /.test(line))
        .filter((line) => !/^\[[^\]]{1,120}\]$/.test(line))
        .join("\n"),
    )
    .filter((paragraph) => paragraph.trim() !== "");
}

/**
 * Duplication fraction of a rendered contribution against the live surface —
 * the real-path version of `measureWindow`, because the plugin hands back text,
 * not a window object.
 */
function measureContribution(text, messages, options = {}) {
  const live = surfaceText(messages, options);
  const paragraphs = contributionParagraphs(text);
  const rows = paragraphs.map((paragraph) => {
    // Same canonicalisation as `storedBody`: rendering adds `[kind | source]`
    // (already dropped as a line) and capture stores `user: ` / `assistant: `.
    const body = normalizeText(normalizeText(paragraph).replace(STORED_HEADER, "").replace(STORED_LABEL, ""));
    return { text: paragraph, tokens: estimateTokens(paragraph), duplicate: body !== "" && live.includes(body) };
  });
  const tokens = rows.reduce((sum, row) => sum + row.tokens, 0);
  const dupTokens = rows.filter((row) => row.duplicate).reduce((sum, row) => sum + row.tokens, 0);
  return {
    rows,
    tokens,
    dupTokens,
    fraction: tokens === 0 ? 0 : dupTokens / tokens,
    paragraphs,
  };
}

test("host without deriveMessages(): no throw, and no information lost", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "cp-dedupe-degrade-"));
  const historyText = "the archive retention policy keeps seven years of audit records";
  const codePath = join(workspace, "src/archive/retention.js");
  mkdirSync(join(workspace, "src/archive"), { recursive: true });
  writeFileSync(codePath, "export function retentionYears() { return 7; } // audit records\n", "utf8");

  // A host with the primitive, so the comparison has a capable baseline.
  const capable = makeHost();
  apply(capable.host, { backend: "sqlite", defaultIndex: ".lce/index.db", autoIndexFiles: false, fileWatch: false });
  const capableContribution = capable.contexts.get(PROMPT_CONTEXT_NAME);
  assert.ok(capableContribution, "autoInject registers the prompt context");
  const capableIngest = capable.tools.find((tool) => tool.name === "context_prism_ingest");
  await capableIngest.execute(
    { path: codePath, kind: "code" },
    { agent: { session: { header: { cwd: workspace } } } },
  );

  const capableSession = sessionWith("capable-session", workspace, [{ role: "user", text: historyText }]);
  capableSession.deriveMessages = () => [{ role: "user", content: [{ type: "text", text: historyText }] }];
  const capableText = await capableContribution.text({ agent: { id: capableSession.id, session: capableSession } });
  assert.equal(diagnostics.presence.source, "session.deriveMessages");
  assert.equal(capableText.includes(historyText), false, "capable host: history the request carries is dropped");
  assert.equal(capableText.includes("retentionYears"), true, "capable host: project code is injected");

  // A host without the primitive: the same workspace, the same session events,
  // but `deriveMessages` simply does not exist.
  const degraded = makeHost();
  apply(degraded.host, { backend: "sqlite", defaultIndex: ".lce/index.db", autoIndexFiles: false, fileWatch: false });
  const degradedContribution = degraded.contexts.get(PROMPT_CONTEXT_NAME);
  const degradedIngest = degraded.tools.find((tool) => tool.name === "context_prism_ingest");
  await degradedIngest.execute(
    { path: codePath, kind: "code" },
    { agent: { session: { header: { cwd: workspace } } } },
  );

  const degradedSession = sessionWith("degraded-session", workspace, [{ role: "user", text: historyText }]);
  assert.equal(typeof degradedSession.deriveMessages, "undefined");

  const missesBefore = diagnostics.presence.misses;
  let degradedText;
  assert.doesNotThrow(async () => {
    degradedText = await degradedContribution.text({ agent: { id: degradedSession.id, session: degradedSession } });
  });
  degradedText = await degradedContribution.text({ agent: { id: degradedSession.id, session: degradedSession } });

  t.diagnostic(`degraded host: source=${diagnostics.presence.source}, misses ${missesBefore} -> ${diagnostics.presence.misses}`);
  t.diagnostic(`capable contribution ${estimateTokens(capableText)} tok; degraded ${estimateTokens(degradedText)} tok`);

  assert.equal(diagnostics.presence.source, "none", "a host without the primitive is reported, not guessed");
  assert.ok(diagnostics.presence.misses > missesBefore, "the degrade must be counted");
  assert.notEqual(degradedText, "", "a degrading host must still inject");
  // Nothing the capable host injected may be missing here: the degraded path is
  // conservative (inject everything), never lossy.
  for (const paragraph of contributionParagraphs(capableText)) {
    const body = normalizeText(paragraph.replace(STORED_HEADER, ""));
    assert.equal(
      normalizeText(degradedText).includes(body),
      true,
      "degraded host must inject everything the capable host would",
    );
  }
  assert.equal(degradedText.includes(historyText), true, "degraded host keeps history injectable instead of dropping it");

  // A throwing projection must degrade the same way rather than fail assembly.
  degradedSession.deriveMessages = () => {
    throw new Error("projection unavailable");
  };
  const throwingText = await degradedContribution.text({ agent: { id: degradedSession.id, session: degradedSession } });
  assert.equal(diagnostics.presence.source, "none");
  assert.equal(throwingText.includes(historyText), true, "a rejecting projection must not lose history");
});

// ---------------------------------------------------------------------------
// 8. The real path: the plugin contribution itself, measured
// ---------------------------------------------------------------------------

test("real path: the contribution stops restating the prompt, with and without project material", async (t) => {
  const turns = 4;

  const drive = async ({ workspace, sessionId, config, withProjects = false }) => {
    const { host, contexts, tools } = makeHost();
    apply(host, config);
    const contribution = contexts.get(PROMPT_CONTEXT_NAME);
    // Optional project corpus the request does NOT carry, indexed through the
    // plugin's own tool so the contribution sees it on the real path.
    if (withProjects) {
      const ingest = tools.find((tool) => tool.name === "context_prism_ingest");
      for (const [path, kind] of [
        [join(workspace, "src/ledger/settle.js"), "code"],
        [join(workspace, "docs/ledger-runbook.md"), "file"],
      ]) {
        await ingest.execute({ path, kind }, { agent: { session: { header: { cwd: workspace } } } });
      }
    }
    const { events, perTurn } = buildSession({ turns });
    const rows = [];
    for (let turn = 1; turn <= turns; turn += 1) {
      const liveEvents = events.slice(0, turn * perTurn);
      const session = { id: sessionId, header: { cwd: workspace }, events: liveEvents };
      const liveMessages = messagesOf(liveEvents);
      session.deriveMessages = () => liveMessages;
      const text = await contribution.text({ agent: { id: sessionId, session } });
      rows.push({ turn, text, measure: measureContribution(text, liveMessages) });
    }
    return rows;
  };

  const totalsOf = (rows) =>
    rows.reduce(
      (sum, row) => ({ tokens: sum.tokens + row.measure.tokens, dup: sum.dup + row.measure.dupTokens }),
      { tokens: 0, dup: 0 },
    );

  // Case 1 — history only. The baseline is a pure restatement of the prompt,
  // and the contribution must collapse to nothing once duplicates are dropped.
  const bare = mkdtempSync(join(tmpdir(), "cp-dedupe-real-bare-"));
  const bareBefore = totalsOf(
    await drive({ workspace: bare, sessionId: "real-bare-before", config: { backend: "sqlite", defaultIndex: ".lce/index.db", autoIndexFiles: false, fileWatch: false, dedupeAgainstPrompt: false } }),
  );
  const bareAfter = totalsOf(
    await drive({ workspace: bare, sessionId: "real-bare-after", config: { backend: "sqlite", defaultIndex: ".lce/index.db", autoIndexFiles: false, fileWatch: false } }),
  );
  t.diagnostic(`real path (history only) before: ${bareBefore.tokens} tok, ${bareBefore.dup} duplicating (${percent(bareBefore.dup, bareBefore.tokens, 2)})`);
  t.diagnostic(`real path (history only) after:  ${bareAfter.tokens} tok, ${bareAfter.dup} duplicating (${percent(bareAfter.dup, bareAfter.tokens, 2)})`);
  assert.ok(bareBefore.tokens > 200, `baseline contribution must be material, got ${bareBefore.tokens}`);
  assert.equal(bareBefore.dup, bareBefore.tokens, "baseline: every injected token restates the prompt");
  assert.equal(bareAfter.tokens, 0, "after: nothing left to say when the request already holds it all");
  assert.equal(bareAfter.dup, 0);

  // Case 2 — the same session plus a project corpus the request does not carry.
  const workspace = projectWorkspace();
  const beforeRows = await drive({
    workspace,
    withProjects: true,
    sessionId: "real-project-before",
    config: { backend: "sqlite", defaultIndex: ".lce/index.db", autoIndexFiles: false, fileWatch: false, dedupeAgainstPrompt: false },
  });
  const afterRows = await drive({
    workspace,
    withProjects: true,
    sessionId: "real-project-after",
    config: { backend: "sqlite", defaultIndex: ".lce/index.db", autoIndexFiles: false, fileWatch: false },
  });
  const before = totalsOf(beforeRows);
  const after = totalsOf(afterRows);
  t.diagnostic(`real path (with project corpus) before: ${before.tokens} tok, ${before.dup} duplicating (${percent(before.dup, before.tokens, 2)})`);
  t.diagnostic(`real path (with project corpus) after:  ${after.tokens} tok, ${after.dup} duplicating (${percent(after.dup, after.tokens, 2)})`);
  t.diagnostic(`real path after paragraphs: ${JSON.stringify(contributionParagraphs(afterRows.at(-1).text).map((p) => p.slice(0, 36)))}`);

  assert.ok(before.dup > 0, "baseline must restate the prompt at least sometimes");
  assert.ok(after.tokens > 0, "the project corpus must still be injected");
  assert.equal(after.dup, 0, "no injected paragraph may restate a live message");
  assert.equal(after.tokens <= before.tokens, true, "the after contribution must not be larger than the baseline it replaced");
  assert.equal(afterRows.at(-1).text.includes("postLedgerEntry"), true, "the code answer survives the real path");
  assert.equal(afterRows.at(-1).text.includes("The settlement cadence is 900 milliseconds"), true, "the runbook answer survives the real path");
  for (const row of beforeRows) {
    assert.ok(row.measure.fraction > 0, `real path turn ${row.turn}: the baseline must restate the prompt`);
  }
});

test("real path: a compaction-replaced message is restored, then withheld once the surface carries it", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "cp-dedupe-real-compact-"));
  const { host, contexts } = makeHost();
  apply(host, { backend: "sqlite", defaultIndex: ".lce/index.db", autoIndexFiles: false, fileWatch: false });
  const contribution = contexts.get(PROMPT_CONTEXT_NAME);

  const message = "the archive retention policy keeps seven years of audit records";
  const session = sessionWith("real-compact-session", workspace, [{ role: "user", text: message }]);

  // The compaction has already replaced the message out of the surface.
  session.deriveMessages = () => [{ role: "assistant", content: [{ type: "text", text: "Understood." }] }];
  const restored = await contribution.text({ agent: { id: session.id, session } });
  t.diagnostic(`restored ${estimateTokens(restored)} tokens; source=${diagnostics.presence.source}; messages=${diagnostics.presence.messages}`);
  assert.equal(diagnostics.presence.source, "session.deriveMessages");
  assert.equal(restored.includes("seven years of audit records"), true, "compacted-away history must come back");

  // The surface now carries it again.
  session.deriveMessages = () => [{ role: "user", content: [{ type: "text", text: message }] }];
  const withheld = await contribution.text({ agent: { id: session.id, session } });
  assert.equal(withheld.includes("seven years of audit records"), false, "history back on the surface must not be restated");
});

// ---------------------------------------------------------------------------
// 9. Residual: tool-call arguments are not read as text (measured, bounded)
// ---------------------------------------------------------------------------

test("a session WITH tool calls leaves a bounded residual: tool-call args are not treated as present", (t) => {
  const engine = new LocalContextEngine();
  const { events, perTurn } = buildSession({ turns: TOTAL_TURNS, withToolCalls: true });
  const sessionId = "tool-call-session";

  const rows = [];
  for (let turn = WARMUP_TURNS + 1; turn <= TOTAL_TURNS; turn += 1) {
    const liveEvents = events.slice(0, turn * perTurn);
    engine.captureSessionEvents({ session: { id: sessionId, events: liveEvents }, cursor: engine.sessionCursor(sessionId) });
    const liveText = messagesOf(liveEvents);
    const liveBroad = messagesOf(liveEvents, { toolCalls: true });
    const presence = buildPresenceIndex(liveText);
    const base = { query: latestQuery(liveEvents), maxTokens: MAX_TOKENS, reservedOutputTokens: RESERVED_TOKENS, scope: sessionId };
    const before = engine.buildContext({ ...base, presence, dedupeAgainstPrompt: false });
    const after = engine.buildContext({ ...base, presence });
    assertAccounting(before, `tool-call turn ${turn} before`);
    assertAccounting(after, `tool-call turn ${turn} after`);
    rows.push({
      turn,
      before: measureWindow(before, liveText),
      after: measureWindow(after, liveText),
      afterBroad: measureWindow(after, liveBroad, { toolCalls: true }),
      afterWindow: after,
    });
  }

  const beforeTokens = rows.reduce((sum, row) => sum + row.before.tokens, 0);
  const afterTokens = rows.reduce((sum, row) => sum + row.after.tokens, 0);
  const residualTokens = rows.reduce((sum, row) => sum + row.afterBroad.dupTokens, 0);
  const residualIds = rows.flatMap((row) => row.afterBroad.items.filter((item) => item.duplicate).map((item) => item.id));
  t.diagnostic(`tool-call session: before ${beforeTokens} tok, after ${afterTokens} tok (text duplication ${rows.reduce((s, r) => s + r.after.dupTokens, 0)})`);
  t.diagnostic(`residual by the broad definition (tool-call blocks included): ${residualTokens} tok over ${rows.length} steps`);
  t.diagnostic(`residual ids sample: ${JSON.stringify(residualIds.slice(0, 4))}`);

  // The text-block metric still holds: nothing the request carries as text is
  // restated, and the absolute saving is real.
  assert.equal(rows.reduce((sum, row) => sum + row.after.dupTokens, 0), 0);
  assert.ok(afterTokens < beforeTokens * 0.25, "the after window must be far smaller than the baseline");

  // The residual must stay bounded and must be attributable: every remaining
  // duplicated item is a captured `tool/call`, whose arguments the request
  // carries in a `tool-call` block that presence.js does not read as text.
  // (Reported as a finding with this task; the bound fails loudly if it grows.)
  assert.ok(
    residualTokens <= beforeTokens * 0.2,
    `tool-call residual must stay bounded: ${residualTokens} of ${beforeTokens} baseline tokens`,
  );
  assert.equal(
    rows.flatMap((row) => row.afterBroad.items.filter((item) => item.duplicate)).every((item) => /tool-call/.test(item.id)),
    true,
    "every residual duplicate must be a tool/call chunk",
  );
  assert.ok(rows.every((row) => row.afterBroad.dupTokens <= 200), "per-step residual must stay small");
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply } from "../lib/index.js";
import { LocalContextEngine } from "../engine/engine.js";

function makeContext(workspacePath = null) {
  const tools = [];
  const listeners = {};
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
    workspaceRegistry: {
      async resolveByPath(path) {
        if (workspacePath) return { path: workspacePath };
        return { path };
      },
    },
    on(event, listener) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(listener);
    },
  };
  return { ctx, tools, listeners };
}

/** One DSH-shaped session: `user/message` carries `content` as blocks. */
function makeSession(id, cwd, text) {
  return {
    id,
    header: { cwd },
    events: [
      {
        seq: 1,
        type: "user/message",
        data: { role: "user", content: [{ type: "text", text }] },
        time: Date.now(),
      },
    ],
  };
}

test("DSH plugin registers seven tools", () => {
  const { ctx, tools } = makeContext();
  apply(ctx, { backend: "json", defaultIndex: ".lce_test_index.json" });
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "context_prism_build",
    "context_prism_dashboard",
    "context_prism_evaluate",
    "context_prism_ingest",
    "context_prism_report",
    "context_prism_status",
    "context_prism_summarize",
  ]);
});

test("DSH plugin context_prism_ingest and context_prism_build work in-process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lce-plugin-"));
  const indexPath = join(dir, "index.json");
  const { ctx, tools } = makeContext(dir);
  apply(ctx, { backend: "json", defaultIndex: indexPath });

  const ingest = tools.find((tool) => tool.name === "context_prism_ingest");
  const build = tools.find((tool) => tool.name === "context_prism_build");
  assert.ok(ingest);
  assert.ok(build);

  const filePath = join(dir, "note.md");
  writeFileSync(filePath, "User prefers concise local-first context.", "utf8");
  const exec = { agent: { session: { header: { cwd: dir } } } };

  const ingestResult = await ingest.execute(
    { path: filePath, kind: "preference", index: indexPath, backend: "json" },
    exec,
  );
  assert.match(ingestResult.output, /Ingested 1 chunks/);

  const buildResult = await build.execute(
    { query: "local-first context", maxTokens: 300, reservedOutputTokens: 60, index: indexPath, backend: "json" },
    exec,
  );
  assert.match(buildResult.output, /local-first/);
  assert.ok(buildResult.report.totalTokens > 0);
});

test("plugin uses workspace-level default index under .lce", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lce-workspace-"));
  const { ctx, tools } = makeContext(dir);
  apply(ctx, { backend: "sqlite", defaultIndex: ".lce/index.db" });
  const build = tools.find((tool) => tool.name === "context_prism_build");
  const exec = { agent: { session: { header: { cwd: dir } } } };

  const result = await build.execute({ query: "hello", maxTokens: 200, reservedOutputTokens: 40 }, exec);
  assert.ok(result.output.includes("Tokens:"));
  assert.ok(existsSync(join(dir, ".lce", "index.db")));
});

test("plugin contributes per-step context through the system prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lce-auto-"));
  const { ctx } = makeContext(dir);
  const contexts = new Map();
  ctx.systemPrompt = { context: (contribution) => (contexts.set(contribution.name, contribution), () => {}) };
  apply(ctx, { backend: "sqlite", defaultIndex: ".lce/index.db", autoIndexFiles: false, fileWatch: false });

  const contribution = contexts.get("context-prism");
  assert.ok(contribution, "autoInject registers a prompt context");

  const events = [
    { seq: 1, type: "user/message", data: { message: { role: "user", content: [{ type: "text", text: "How should I assemble a dynamic context window?" }] } }, time: Date.now() },
    { seq: 2, type: "assistant/message", data: { message: { content: [{ type: "text", text: "Use retrieval and compression." }] } }, time: Date.now() },
    { seq: 3, type: "tool/call", data: { name: "search_index", arguments: "{}" }, time: Date.now() },
  ];
  const agent = { id: "auto-test-session", session: { id: "auto-test-session", header: { cwd: dir }, events } };

  const text = await contribution.text({ agent });
  assert.match(text, /\[ContextPrism\] local context for this step/);
  assert.match(text, /dynamic context window/, "the captured question is retrievable");
  assert.ok(existsSync(join(dir, ".lce", "index.db")), "capture persists into the workspace index");
});

test("workspace scan indexes text files into the project index", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lce-scan-"));
  writeFileSync(join(dir, "notes.md"), "The archive retention policy keeps seven years of audit records.", "utf8");
  const { ctx, tools } = makeContext(dir);
  const contexts = new Map();
  ctx.systemPrompt = { context: (contribution) => (contexts.set(contribution.name, contribution), () => {}) };
  apply(ctx, { backend: "sqlite", defaultIndex: ".lce/index.db", autoIndexFiles: true, autoIndexIntervalMs: 0, fileWatch: false });

  const agent = { id: "scan-session", session: { id: "scan-session", header: { cwd: dir }, events: [
    { seq: 1, type: "user/message", data: { message: { role: "user", content: [{ type: "text", text: "What is the archive retention policy?" }] } }, time: Date.now() },
  ] } };
  const text = await contexts.get("context-prism").text({ agent });
  assert.match(text, /seven years/, "files on disk must reach the window, not just session history");

  const status = tools.find((tool) => tool.name === "context_prism_status");
  const result = await status.execute({}, { agent: { session: { header: { cwd: dir } } } });
  assert.ok(result.report.totalChunks > 0);
  assert.ok(result.report.byKind.file >= 1);
});

test("plugin generates standalone HTML dashboard from the structured report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lce-dash-"));
  const { ctx, tools } = makeContext(dir);
  apply(ctx, { backend: "sqlite", defaultIndex: ".lce/index.db", autoIndexFiles: false });
  const dashboard = tools.find((tool) => tool.name === "context_prism_dashboard");
  assert.ok(dashboard);

  const exec = { agent: { session: { header: { cwd: dir } } } };
  const result = await dashboard.execute({}, exec);
  assert.ok(result.path.endsWith(".lce/dashboard.html"));
  assert.ok(existsSync(result.path));
  const html = readFileSync(result.path, "utf8");
  assert.match(html, /ContextPrism Dashboard/);
  assert.match(html, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the page names its own project");
});

// ---------------------------------------------------------------------------
// Session scope
// ---------------------------------------------------------------------------

test("two sessions sharing one workspace index never see each other's history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lce-scope-"));
  const { ctx, tools } = makeContext(dir);
  const contexts = new Map();
  ctx.systemPrompt = { context: (contribution) => (contexts.set(contribution.name, contribution), () => {}) };
  apply(ctx, {
    backend: "sqlite",
    defaultIndex: ".lce/index.db",
    autoIndexFiles: false,
    fileWatch: false,
  });
  const contribution = contexts.get("context-prism");

  const alpha = makeSession("sess-alpha", dir, "Alpha deployment: the alpha canary uses a blue release flag.");
  const beta = makeSession("sess-beta", dir, "Beta deployment: the beta canary uses a green release flag.");

  const alphaText = await contribution.text({ agent: { id: "sess-alpha", session: alpha } });
  const betaText = await contribution.text({ agent: { id: "sess-beta", session: beta } });

  assert.match(alphaText, /blue release flag/, "a session sees its own history");
  assert.doesNotMatch(alphaText, /green release flag/, "and never the other session's");
  assert.match(betaText, /green release flag/, "the other session sees its own history");
  assert.doesNotMatch(betaText, /blue release flag/, "and never the first session's");

  // The same index really does hold both sessions' chunks: isolation comes from
  // the scope, not from the second session failing to capture.
  const engine = new LocalContextEngine({ storagePath: join(dir, ".lce", "index.db"), backend: "sqlite" });
  const history = engine.index.chunksByKind("history");
  assert.equal(history.length, 2, "both sessions captured into one shared index");
  assert.equal(engine.sessionCursor("sess-alpha"), 1);
  assert.equal(engine.sessionCursor("sess-beta"), 1);
});

test("context_prism_build scopes to the caller and refuses a cross-session read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lce-build-scope-"));
  const { ctx, tools } = makeContext(dir);
  const contexts = new Map();
  ctx.systemPrompt = { context: (contribution) => (contexts.set(contribution.name, contribution), () => {}) };
  apply(ctx, {
    backend: "sqlite",
    defaultIndex: ".lce/index.db",
    autoIndexFiles: false,
    fileWatch: false,
  });

  const alpha = makeSession("sess-alpha", dir, "Alpha canary uses a blue release flag.");
  const beta = makeSession("sess-beta", dir, "Beta canary uses a green release flag.");
  await contexts.get("context-prism").text({ agent: { id: "sess-alpha", session: alpha } });
  await contexts.get("context-prism").text({ agent: { id: "sess-beta", session: beta } });

  const build = tools.find((tool) => tool.name === "context_prism_build");
  const exec = { agent: { session: alpha } };
  const result = await build.execute({ query: "canary release flag", maxTokens: 800, reservedOutputTokens: 100 }, exec);
  assert.equal(result.report.scope, "sess-alpha");
  assert.doesNotMatch(result.output, /green release flag/);

  await assert.rejects(
    () => build.execute({ query: "canary", session: "sess-beta" }, exec),
    /cannot read another session/,
    "the session parameter is not a cross-session read primitive",
  );
});

test("no module-level variable decides which project a request reads", () => {
  const source = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  // The v0.8 global is not merely unused, it is absent: a null-initialised
  // "last project" tends to come back, and the whole point of D5 is that one
  // request must not be able to observe another request's project.
  assert.doesNotMatch(source, /lastProjectRoot/, "the module-level project global must be gone");
  assert.match(source, /function resolveRouteProject\(/, "the route resolves its own project per request");
});

// ---------------------------------------------------------------------------
// Structured report
// ---------------------------------------------------------------------------

test("context_prism_report returns JSON with counts by kind, scopes and injection counters", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lce-report-"));
  const { ctx, tools } = makeContext(dir);
  const contexts = new Map();
  ctx.systemPrompt = { context: (contribution) => (contexts.set(contribution.name, contribution), () => {}) };
  apply(ctx, {
    backend: "sqlite",
    defaultIndex: ".lce/index.db",
    autoIndexFiles: false,
    fileWatch: false,
  });

  const session = makeSession("sess-report", dir, "Report canary uses a violet release flag.");
  await contexts.get("context-prism").text({ agent: { id: "sess-report", session } });

  const report = tools.find((tool) => tool.name === "context_prism_report");
  assert.ok(report, "the structured report tool exists");
  const result = await report.execute({}, { agent: { session: { header: { cwd: dir } } } });

  const body = result.report;
  assert.equal(body.schemaVersion, 1);
  assert.equal(typeof body.generatedAt, "number");
  assert.equal(body.project.root, dir);
  assert.equal(body.project.source, "cwd");
  assert.ok(body.index.path.endsWith(".lce/index.db"));
  assert.equal(body.index.backend, "sqlite");
  assert.equal(typeof body.index.revision, "number");

  // Every kind is present, so `sum(byKind) === total` can be relied on.
  assert.deepEqual(Object.keys(body.counts.byKind).sort(), [
    "code",
    "file",
    "history",
    "preference",
    "session_cursor",
    "trajectory",
  ]);
  const summed = Object.values(body.counts.byKind).reduce((sum, count) => sum + count, 0);
  assert.equal(summed, body.counts.total);
  assert.equal(body.counts.byScope.sessionScoped + body.counts.byScope.projectScoped, body.counts.total);
  assert.equal(body.counts.byScope.sessionScoped, body.counts.byKind.history);

  // Per-session scope, counts only.
  assert.deepEqual(body.sessions.map((row) => row.sessionId), ["sess-report"]);
  assert.equal(body.sessions[0].history, 1);
  assert.equal(body.sessions[0].cursor, 1);
  assert.equal(typeof body.sessions[0].lastChunkAt, "number");

  // Injection counters.
  assert.equal(body.injection.mode, "prompt-context");
  assert.ok(body.injection.injections >= 1);
  assert.equal(typeof body.injection.skippedEmpty, "number");
  assert.equal(typeof body.injection.reentries, "number");
  assert.ok(Array.isArray(body.injection.last.sections));

  // Host compatibility and index search diagnostics.
  assert.equal(typeof body.host.supported, "boolean");
  assert.match(body.host.target, /^\d+\.\d+\.\d+/);
  assert.deepEqual(Object.keys(body.diagnostics.search).sort(), [
    "ftsErrorCount",
    "lastFallbackAt",
    "likeFallbackCount",
    "likeFallbackRows",
    "searchTextMigration",
  ]);

  // An audit view, not a cross-session read channel.
  assert.doesNotMatch(JSON.stringify(body), /violet release flag/, "no chunk content in a report");
  assert.doesNotMatch(result.output, /violet release flag/);
  assert.match(result.output, /By kind:/);
});

test("context_prism_status stays consistent with the structured report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lce-status-report-"));
  const { ctx, tools } = makeContext(dir);
  apply(ctx, { backend: "json", defaultIndex: ".lce/index.json", autoIndexFiles: false, fileWatch: false });
  const exec = { agent: { session: { header: { cwd: dir } } } };

  const status = await tools.find((tool) => tool.name === "context_prism_status").execute({}, exec);
  const report = await tools.find((tool) => tool.name === "context_prism_report").execute({}, exec);

  assert.equal(status.report.totalChunks, report.report.counts.total);
  assert.deepEqual(status.report.counts.byKind, report.report.counts.byKind);
});

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

test("plugin evaluates labelled queries across the three routes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lce-eval-"));
  const { ctx, tools } = makeContext(dir);
  apply(ctx, { backend: "json", defaultIndex: ".lce/index.json", autoIndexFiles: false });
  const evaluate = tools.find((tool) => tool.name === "context_prism_evaluate");
  assert.ok(evaluate);

  const engine = new LocalContextEngine({ storagePath: join(dir, ".lce", "index.json"), backend: "json" });
  engine.addText({
    content: "User prefers concise Chinese and local RAG context windows.",
    source: "pref.md",
    kind: "preference",
    priority: 10,
  });
  engine.addText({
    content: "History: the user asked about dynamic context window assembly.",
    source: "history.log",
    kind: "history",
  });
  engine.save();
  const preference = engine.index.chunksByKind("preference")[0].id;
  const history = engine.index.chunksByKind("history")[0].id;

  const exec = { agent: { session: { header: { cwd: dir } } } };
  const result = await evaluate.execute(
    {
      queries: JSON.stringify([
        { id: "q1", query: "dynamic context window", goldChunkIds: [history] },
        { id: "q2", query: "user preference", goldChunkIds: [preference] },
      ]),
      index: join(dir, ".lce", "index.json"),
      backend: "json",
    },
    exec,
  );

  assert.equal(result.report.total, 2, "report.total keeps working for existing callers");
  assert.equal(result.report.total, result.report.queryCount);
  assert.deepEqual(result.report.routes, ["no-injection", "bm25-only", "hybrid"]);
  assert.equal(result.report.byRoute["no-injection"].injectedTokens, 0, "the control injects nothing");
  assert.ok(result.report.byRoute["bm25-only"].recallAtK > 0);
  assert.ok(result.output.includes("hit rate"), "the hit-rate line survives for existing callers");
  for (const route of ["no-injection", "bm25-only", "hybrid"]) {
    assert.ok(result.output.includes(route), `the output names the ${route} route`);
  }
});

test("context_prism_evaluate with no queries runs the committed bench fixture", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lce-eval-bench-"));
  const { ctx, tools } = makeContext(dir);
  apply(ctx, { backend: "json", defaultIndex: ".lce/index.json", autoIndexFiles: false, fileWatch: false });
  const evaluate = tools.find((tool) => tool.name === "context_prism_evaluate");

  const result = await evaluate.execute({}, { agent: { session: { header: { cwd: dir } } } });
  assert.equal(result.report.source, "bench");
  assert.equal(result.report.queryCount, 41);
  assert.equal(result.report.corpusSize, 41);
  assert.deepEqual(result.report.routes, ["no-injection", "bm25-only", "hybrid"]);
  assert.ok(result.report.byRoute["bm25-only"].recallAtK > 0.5, "the fixture is not trivially unanswerable");
  assert.equal(result.report.byRoute["no-injection"].hitRate, 0);
});

test("a legacy expected label is resolved to gold ids instead of substring-matching hits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lce-eval-legacy-"));
  const { ctx, tools } = makeContext(dir);
  apply(ctx, { backend: "json", defaultIndex: ".lce/index.json", autoIndexFiles: false, fileWatch: false });
  const evaluate = tools.find((tool) => tool.name === "context_prism_evaluate");
  const exec = { agent: { session: { header: { cwd: dir } } } };

  const engine = new LocalContextEngine({ storagePath: join(dir, ".lce", "index.json"), backend: "json" });
  engine.addText({
    content: "Rollback procedure: restore the previous release and page the on-call engineer.",
    source: "ops.md",
    kind: "file",
  });
  engine.save();

  const result = await evaluate.execute(
    { queries: JSON.stringify([{ query: "rollback procedure", expected: "page the on-call" }]), backend: "json" },
    exec,
  );
  assert.equal(result.report.total, 1);
  assert.ok(result.report.warnings.some((warning) => /legacy label/.test(warning)));
  assert.ok(result.report.byRoute["bm25-only"].recallAtK > 0, "the resolved id is what gets ranked");
  assert.ok(result.output.includes("hit rate"));
});

test("context_prism_evaluate rejects a label that matches nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lce-eval-bad-"));
  const { ctx, tools } = makeContext(dir);
  apply(ctx, { backend: "json", defaultIndex: ".lce/index.json", autoIndexFiles: false, fileWatch: false });
  const evaluate = tools.find((tool) => tool.name === "context_prism_evaluate");
  const exec = { agent: { session: { header: { cwd: dir } } } };

  const engine = new LocalContextEngine({ storagePath: join(dir, ".lce", "index.json"), backend: "json" });
  engine.addText({ content: "Rollback procedure for the release train.", source: "ops.md", kind: "file" });
  engine.save();

  await assert.rejects(
    () =>
      evaluate.execute(
        { queries: JSON.stringify([{ query: "rollback", expected: "no such phrase anywhere" }]), backend: "json" },
        exec,
      ),
    /matches no chunk/,
  );
});

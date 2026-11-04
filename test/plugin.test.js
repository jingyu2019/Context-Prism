import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("DSH plugin registers both tools", () => {
  const { ctx, tools } = makeContext();
  apply(ctx, { backend: "json", defaultIndex: ".lce_test_index.json" });
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "context_prism_build",
    "context_prism_dashboard",
    "context_prism_evaluate",
    "context_prism_ingest",
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

  const result = await build.execute(
    { query: "hello", maxTokens: 200, reservedOutputTokens: 40 },
    exec,
  );
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

test("plugin generates standalone HTML dashboard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lce-dash-"));
  const { ctx, tools } = makeContext(dir);
  apply(ctx, { backend: "sqlite", defaultIndex: ".lce/index.db", autoIndexFiles: false });
  const dashboard = tools.find((tool) => tool.name === "context_prism_dashboard");
  assert.ok(dashboard);

  const exec = { agent: { session: { header: { cwd: dir } } } };
  const result = await dashboard.execute({}, exec);
  assert.ok(result.path.endsWith(".lce/dashboard.html"));
  assert.ok(existsSync(result.path));
});

test("plugin runs A/B retrieval evaluation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lce-eval-"));
  const { ctx, tools } = makeContext(dir);
  apply(ctx, { backend: "json", defaultIndex: ".lce/index.json", autoIndexFiles: false });
  const build = tools.find((tool) => tool.name === "context_prism_build");
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

  const exec = { agent: { session: { header: { cwd: dir } } } };
  const result = await evaluate.execute(
    {
      queries: JSON.stringify([
        { query: "dynamic context window", expected: "dynamic" },
        { query: "user preference", expected: "preference" },
      ]),
      index: join(dir, ".lce", "index.json"),
      backend: "json",
    },
    exec,
  );
  assert.ok(result.report.total === 2);
  assert.ok(result.output.includes("hit rate"));
});

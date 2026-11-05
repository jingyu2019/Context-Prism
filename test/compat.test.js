// Contract tests against the DeepSeek Harness 0.2.1-rc.5 plugin API.
//
// These exist because every failure they cover was silent: an empty index made
// auto-injection a no-op, block content was read as a string, and a thrown
// error inside the injection path was caught and dropped. Each test asserts on
// an observable effect rather than on internal calls, so a host upgrade that
// changes the contract fails here instead of in a user's session.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

import { apply, diagnostics, PROMPT_CONTEXT_NAME } from "../lib/index.js";
import { LocalContextEngine } from "../engine/engine.js";
import { SourceKind } from "../engine/models.js";
import { blocksToText, describeEvent, readSessionEvents, sessionIdOf } from "../engine/session_events.js";
import { checkHostVersion, compareVersions, parseVersion, TARGET_DSH_VERSION } from "../engine/version.js";

/** Build the minimum host surface `apply` touches, with a prompt-context recorder. */
function makeHost() {
  const contexts = new Map();
  const listeners = {};
  const tools = [];
  const host = {
    tools: { register: (definition) => (tools.push(definition), () => {}) },
    workspaceRegistry: { resolveByPath: async (path) => ({ path }) },
    webServer: { register: () => () => {} },
    systemPrompt: { context: (contribution) => (contexts.set(contribution.name, contribution), () => {}) },
    on: (event, listener) => ((listeners[event] ??= []).push(listener), () => {}),
  };
  return { host, contexts, listeners, tools };
}

/** One DSH-shaped session: `user/message` carries the message, others nest it. */
function makeSession(cwd, extraEvents = []) {
  const now = Date.now();
  return {
    id: "sess-test",
    header: { cwd },
    events: [
      { seq: 1, time: now, type: "user/message", data: createUserMessage({ content: [{ type: "text", text: "How does the compression budget work?" }], source: { kind: "user" } }) },
      { seq: 2, time: now, type: "assistant/message", data: { message: { content: [{ type: "text", text: "compressItems packs chunks by score until the budget is spent." }] } } },
      { seq: 3, time: now, type: "tool/call", data: { name: "read", arguments: '{"file_path":"engine/compression.js"}' } },
      ...extraEvents,
    ],
  };
}

function withWorkspaceHost(t, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lce-compat-"));
  const { host, contexts, listeners, tools } = makeHost();
  apply(host, { backend: "sqlite", defaultIndex: ".lce/index.db", autoIndexFiles: false, fileWatch: false, ...config });
  return { dir, host, contexts, listeners, tools };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("plugin targets the DSH release it was verified against", async () => {
  const pkg = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.peerDependencies["@deepseek-ai/dsh-tools"], TARGET_DSH_VERSION);
  assert.equal(pkg.peerDependencies["@deepseek-ai/dsh-llm"], TARGET_DSH_VERSION);
  assert.match(pkg.engines.node, />=\s*22\.5/);
});

/** Version of the `@deepseek-ai/dsh-tools` actually resolved from this package root. */
async function installedToolsVersion() {
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  return req(`${req.resolve("@deepseek-ai/dsh-tools/package.json")}`).version;
}

test("installed host packages are resolvable and version-comparable", async () => {
  const version = await installedToolsVersion();
  // CI installs whatever the registry serves, which can trail the release a
  // desktop app bundles. Assert the plugin can *judge* the host rather than
  // that CI happens to have the newest build.
  assert.ok(parseVersion(version), `unparseable host version ${version}`);
  const check = checkHostVersion(version);
  assert.equal(typeof check.supported, "boolean");
  assert.equal(typeof check.reason, "string");
  if (!check.supported) {
    console.warn(`[compat] dev dependency dsh-tools ${version} is below ${TARGET_DSH_VERSION}; API-shape tests are the real gate here.`);
  }
});

test("version comparison orders prereleases before their release", () => {
  assert.equal(compareVersions("0.2.1-rc.4", "0.2.1-rc.5"), -1);
  assert.equal(compareVersions("0.2.1-rc.5", "0.2.1"), -1);
  assert.equal(compareVersions("0.2.1", "0.2.1-rc.5"), 1);
  assert.equal(compareVersions("v0.3.0", "0.2.1-rc.5"), 1);
  assert.equal(checkHostVersion("0.1.0-rc.6").supported, false);
  assert.equal(checkHostVersion(null).supported, null);
});

test("auto-injection registers a prompt context instead of appending a message", (t) => {
  const { contexts } = withWorkspaceHost(t);
  assert.ok(contexts.has(PROMPT_CONTEXT_NAME), "expected a registered prompt context");
  const contribution = contexts.get(PROMPT_CONTEXT_NAME);
  assert.equal(typeof contribution.text, "function");
  assert.ok(Number.isFinite(contribution.order));
});

test("fresh workspace: injection reports empty instead of throwing", async (t) => {
  const { contexts } = withWorkspaceHost(t);
  const before = diagnostics.skippedEmpty;
  const text = await contexts.get(PROMPT_CONTEXT_NAME).text({ agent: { id: "x", session: makeSession(tmpdir()) } });
  // An empty workspace has nothing to say; the point is that it says so
  // knowingly (a counted skip) rather than failing or silently succeeding.
  assert.equal(typeof text, "string");
  assert.ok(diagnostics.skippedEmpty > before || text.length > 0);
});

test("capture reads block content, not string content", async (t) => {
  const { dir, contexts } = withWorkspaceHost(t);
  const session = makeSession(dir);
  const text = await contexts.get(PROMPT_CONTEXT_NAME).text({ agent: { id: session.id, session } });
  const engine = new LocalContextEngine({ storagePath: join(dir, ".lce/index.db"), backend: "sqlite" });
  const history = engine.index.chunksByKind(SourceKind.HISTORY);
  assert.equal(history.length, 2, "both the user and assistant message must be captured");
  assert.match(history.map((chunk) => chunk.content).join("\n"), /compression budget/);
  assert.equal(engine.sessionCursor(session.id), session.events.at(-1).seq);
  assert.ok(text.length > 0);
});

test("capture is idempotent across repeated steps", async (t) => {
  const { dir, contexts } = withWorkspaceHost(t);
  const session = makeSession(dir);
  const contribution = contexts.get(PROMPT_CONTEXT_NAME);
  await contribution.text({ agent: { id: session.id, session } });
  await contribution.text({ agent: { id: session.id, session } });
  const engine = new LocalContextEngine({ storagePath: join(dir, ".lce/index.db"), backend: "sqlite" });
  assert.equal(engine.index.chunksByKind(SourceKind.HISTORY).length, 2, "re-running must not duplicate chunks");
});

test("new events after a cursor are captured on the next step", async (t) => {
  const { dir, contexts } = withWorkspaceHost(t);
  const session = makeSession(dir);
  const contribution = contexts.get(PROMPT_CONTEXT_NAME);
  await contribution.text({ agent: { id: session.id, session } });
  session.events.push({ seq: 4, time: Date.now(), type: "user/message", data: createUserMessage({ content: [{ type: "text", text: "and how do I raise the budget?" }], source: { kind: "user" } }) });
  const text = await contribution.text({ agent: { id: session.id, session } });
  // Exactly one event is new: the user message at seq 4. The tool/call at seq 3
  // was already captured by the first step (which advanced the cursor to 3), and
  // the capture cursor is exclusive, so it is not re-read or counted again.
  assert.match(text, /New session events captured: 1\b/, "only the new user message is new; the tool/call at seq 3 was captured in the previous step");
  const engine = new LocalContextEngine({ storagePath: join(dir, ".lce/index.db"), backend: "sqlite" });
  assert.equal(engine.sessionCursor(session.id), 4);
});

test("an assembly failure is recorded rather than swallowed", async (t) => {
  const { contexts } = withWorkspaceHost(t);
  diagnostics.lastError = null;
  const broken = { id: "broken", get header() { throw new Error("session header unavailable"); }, events: [] };
  const originalError = console.error;
  console.error = () => {};
  try {
    const text = await contexts.get(PROMPT_CONTEXT_NAME).text({ agent: { id: "broken", session: broken } });
    assert.equal(text, "");
  } finally {
    console.error = originalError;
  }
  assert.ok(diagnostics.lastError, "a failed assembly must leave a diagnostic");
  assert.match(diagnostics.lastError.message, /header unavailable/);
});

test("hosts without a prompt-context service fall back to the pre-step hook", (t) => {
  const { host } = makeHost();
  delete host.systemPrompt;
  const listeners = {};
  host.on = (event, listener) => ((listeners[event] ??= []).push(listener), () => {});
  apply(host, { backend: "json", defaultIndex: ".lce/index.json", autoIndexFiles: false, fileWatch: false });
  assert.equal(listeners["agent/pre-step"]?.length, 1);
});

test("session event shapes are read across host accessors", () => {
  const events = [{ seq: 0 }, { seq: 1 }, { seq: 2 }];
  assert.equal(readSessionEvents({ events }).source, "session.events");
  assert.equal(readSessionEvents({ snapshotEvents: () => events }).source, "session.snapshotEvents");
  assert.equal(readSessionEvents({ eventAt: (seq) => events[seq], seq: 3 }).events.length, 3);
  assert.equal(readSessionEvents({}).total, 0);
  assert.equal(readSessionEvents({ events }, { fromSeq: 2 }).events.length, 1);
  assert.equal(sessionIdOf({ id: "a" }), "a");
  assert.equal(sessionIdOf({ header: { id: "b" } }), "b");
  assert.equal(sessionIdOf(null), null);
});

test("event projection keeps messages and drops contentless events", () => {
  assert.equal(blocksToText([{ type: "text", text: "a" }, { type: "image" }]), "a\n[image]");
  assert.equal(blocksToText("plain"), "plain");
  assert.equal(blocksToText(undefined), "");
  assert.equal(describeEvent({ type: "tool/call", seq: 9, data: { name: "read", arguments: '{"a":1}' } }, "s").kind, SourceKind.TRAJECTORY);
  assert.equal(describeEvent({ type: "assistant/message", seq: 9, data: { message: { content: [] } } }, "s"), null);
  assert.equal(describeEvent({ type: "system/message", seq: 9, data: { message: { content: [{ type: "text", text: "sys" }] } } }, "s"), null);
});

test("session cursors are excluded from retrieved context", async (t) => {
  const { dir, contexts } = withWorkspaceHost(t);
  const session = makeSession(dir);
  await contexts.get(PROMPT_CONTEXT_NAME).text({ agent: { id: session.id, session } });
  const engine = new LocalContextEngine({ storagePath: join(dir, ".lce/index.db"), backend: "sqlite" });
  const window = engine.buildContext({ query: "sess-test", maxTokens: 800, reservedOutputTokens: 100 });
  for (const section of window.sections) {
    for (const item of section.items) {
      assert.notEqual(item.chunk.kind, SourceKind.SESSION_CURSOR, "cursor chunks must never reach the model");
    }
  }
});

test("tool schemas compile under the rc.5 parameter DSL", (t) => {
  // defineTool throws at registration time when a parameter node is outside the
  // supported DSL, so a successful register is the assertion.
  const { tools } = withWorkspaceHost(t);
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
  // `context_prism_report` is the structured view the client panel renders.
  const report = tools.find((tool) => tool.name === "context_prism_report");
  assert.ok(report, "the structured report tool must be registered");
  assert.ok(report.output.schema.properties.report, "it returns a structured report object");
  for (const tool of tools) {
    assert.equal(tool.parameters.type, "object", `${tool.name} parameters must be an object root`);
    assert.equal(typeof tool.output.render, "function");
  }
});

test("defineTool rejects an out-of-DSL parameter annotation", () => {
  assert.throws(
    () =>
      defineTool({
        name: "probe",
        description: "probe",
        parameters: { q: { type: "string", required: true, notAKeyword: 1 } },
        output: { schema: { type: "object", additionalProperties: false, properties: { output: { type: "string", required: true } } }, render: () => [] },
        async execute() {
          return { output: "" };
        },
      }),
    /not supported by the value schema DSL/,
  );
});

test("client bundle requires only the seeds its manifest declares", async () => {
  const fs = await import("node:fs/promises");
  const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  const source = await fs.readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  const required = [...source.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.ok(required.length > 0, "the client bundle must require something");
  assert.ok(pkg.dsh.client.inject.includes("react"), "react must be a declared client seed");
  for (const specifier of required) {
    const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
    assert.ok(
      pkg.dsh.client.inject.includes(packageName),
      `client bundle requires "${specifier}" but the manifest does not declare "${packageName}" as a seed`,
    );
  }
  assert.equal(pkg.dsh.client.platform, "web");
  assert.match(source, /__ModuleLoader__\.load\(/, "a client bundle registers a factory");
  assert.match(source, /id:\s*"context-prism-dsh-plugin"/, "the factory id must match the package name");
});

test("the client panel renders the structured report in place", async () => {
  const fs = await import("node:fs/promises");
  const source = await fs.readFile(new URL("../lib/client.js", import.meta.url), "utf8");

  // Scan executable code, not prose. The header of lib/client.js explains *why*
  // it avoids these APIs, and a bare-word scan would fail on that explanation
  // instead of on a use of the API — so comments are stripped once, here, and the
  // patterns below stay exact. Do not "simplify" this back to a bare identifier.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // D12: the sidebar action used to open a separate document.
  assert.doesNotMatch(code, /window\.open/, "no separate tab: the panel renders inside the shell");
  assert.doesNotMatch(code, /dangerouslySetInnerHTML\s*[:=]/, "no host- or contract-produced HTML inside the panel");
  assert.match(source, /\/context-prism\/report/, "the panel reads the structured report route");
  assert.match(source, /encodeURIComponent/, "the project it asks for is encoded, not concatenated raw");

  // It renders the report's own fields rather than a second data path.
  for (const field of ["counts", "byKind", "byScope", "sessions", "injection", "host"]) {
    assert.match(source, new RegExp(field), `the panel renders ${field}`);
  }

  // Failure paths are visible: an error branch that names the status.
  assert.match(source, /view\.status === "error"/, "a failed fetch renders an error state");
  assert.match(source, /could not load its report/, "the error says what failed");

  // Still only the declared seed.
  const required = [...source.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual(required, ["react"], "react is the only module the panel loads");
});

test("status reports host compatibility and injection mode", async (t) => {
  const { tools } = withWorkspaceHost(t);
  const status = tools.find((tool) => tool.name === "context_prism_status");
  const result = await status.execute({}, { agent: { session: { header: { cwd: tmpdir() } } } });
  assert.equal(result.report.host.supported, true);
  assert.equal(result.report.host.target, TARGET_DSH_VERSION);
  assert.equal(result.report.injection.mode, "prompt-context");
  assert.match(result.output, /Host: 0\.2\.1-rc\.5/);
  await flush();
});

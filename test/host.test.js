// Load the plugin the way the host does: a real Cordis application with the
// services it injects provided by Service subclasses.
//
// The other suites drive `apply()` with a hand-built object, which proves the
// plugin's own logic but not that Cordis accepts it: injection wiring, effect
// ownership, and disposal only exist in a real fiber.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context, Service } from "@deepseek-ai/cordis";

class ToolsStub extends Service {
  constructor(ctx) {
    super(ctx, "tools", true);
    this.registered = [];
  }
  register(definition) {
    this.registered.push(definition);
    return () => {};
  }
}

class WorkspaceStub extends Service {
  constructor(ctx) {
    super(ctx, "workspaceRegistry", true);
  }
  async resolveByPath(path) {
    return { path };
  }
}

class WebStub extends Service {
  constructor(ctx) {
    super(ctx, "webServer", true);
  }
  register() {
    return () => {};
  }
}

class PromptStub extends Service {
  constructor(ctx) {
    super(ctx, "systemPrompt", true);
    this.contexts = new Map();
  }
  context(contribution) {
    this.contexts.set(contribution.name, contribution);
    return () => this.contexts.delete(contribution.name);
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

async function mountHost(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lce-host-"));
  const root = new Context();
  root.plugin(ToolsStub);
  root.plugin(WorkspaceStub);
  root.plugin(WebStub);
  root.plugin(PromptStub);
  await tick();

  const plugin = await import("../lib/index.js");
  const fiber = await root.plugin(
    { name: "context-prism", apply: plugin.apply, inject: plugin.inject, optional: plugin.optionalInject },
    { backend: "json", defaultIndex: ".lce/host.json", autoIndexFiles: false, fileWatch: false, ...config },
  );
  await tick();
  return { dir, root, fiber, tools: root.get("tools"), prompts: root.get("systemPrompt") };
}

test("plugin mounts into a real Cordis application", async () => {
  const { tools, prompts } = await mountHost();
  assert.deepEqual(
    tools.registered.map((tool) => tool.name).sort(),
    ["context_prism_build", "context_prism_dashboard", "context_prism_evaluate", "context_prism_ingest", "context_prism_status", "context_prism_summarize"],
  );
  assert.ok(prompts.contexts.has("context-prism"), "the prompt context must be owned by the fiber");
});

test("Cordis accepts a missing optional service (fallback wiring)", async () => {
  const root = new Context();
  root.plugin(ToolsStub);
  root.plugin(WorkspaceStub);
  root.plugin(WebStub);
  await tick();
  const plugin = await import("../lib/index.js");
  root.plugin(
    { name: "context-prism", apply: plugin.apply, inject: plugin.inject, optional: plugin.optionalInject },
    { backend: "json", defaultIndex: ".lce/host.json", autoIndexFiles: false, fileWatch: false },
  );
  await tick();
  assert.equal(root.get("tools").registered.length, 6, "the plugin still mounts without systemPrompt");
});

test("a disposed fiber drops its registration disposers", async () => {
  // Pin the Cordis contract this plugin's teardown depends on: registration
  // functions returning a disposer, and that disposer running when the owning
  // fiber is disposed. Everything the plugin registers (tools, the prompt
  // context, the HTTP route) relies on it.
  const root = new Context();
  root.plugin(PromptStub);
  await tick();
  const fiber = await root.plugin(
    { name: "dispose-probe", inject: ["systemPrompt"], apply: (ctx) => ctx.systemPrompt.context({ name: "probe", order: 1, text: "probe" }) },
    {},
  );
  await tick();
  const prompts = root.get("systemPrompt");
  assert.ok(prompts.contexts.has("probe"));
  await fiber.dispose();
  await tick();
  assert.equal(prompts.contexts.has("probe"), false, "Cordis must run the disposer a registration returned");
});

test("a captured session reaches the prompt contribution through the host wiring", async () => {
  const { dir, prompts } = await mountHost();
  writeFileSync(join(dir, "team.md"), "Escalation: page the on-call engineer after fifteen minutes.", "utf8");
  const contribution = prompts.contexts.get("context-prism");
  const session = {
    id: "host-session",
    header: { cwd: dir },
    events: [{ seq: 1, time: Date.now(), type: "user/message", data: { role: "user", content: [{ type: "text", text: "what is the escalation policy?" }] } }],
  };
  const text = await contribution.text({ agent: { id: session.id, session } });
  assert.match(text, /\[ContextPrism\]/);
  assert.match(text, /escalation policy/);
});

test("re-mounting does not duplicate the contribution", async () => {
  const { root, prompts } = await mountHost();
  const plugin = await import("../lib/index.js");
  root.plugin(
    { name: "context-prism-2", apply: plugin.apply, inject: plugin.inject, optional: plugin.optionalInject },
    { backend: "json", defaultIndex: ".lce/host2.json", autoIndexFiles: false, fileWatch: false },
  );
  await tick();
  assert.equal(prompts.contexts.size, 1, "the context map is keyed by name, so a second mount replaces");
});

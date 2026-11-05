// Load the plugin the way the host does: a real Cordis application with the
// services it injects provided by Service subclasses.
//
// The other suites drive `apply()` with a hand-built object, which proves the
// plugin's own logic but not that Cordis accepts it: injection wiring, effect
// ownership, and disposal only exist in a real fiber.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
    this.routes = [];
  }
  register(route) {
    this.routes.push(route);
    return () => {
      this.routes = this.routes.filter((entry) => entry !== route);
    };
  }

  /**
   * Invoke the registered prefix handler for one URL.
   *
   * A route is matched by prefix, exactly as the host matches it, so a test can
   * ask for `/context-prism/report?project=…` and see what a browser would see.
   */
  async request(url) {
    const route = this.routes.find((entry) => url.startsWith(entry.path));
    if (!route) throw new Error(`no route registered for ${url}`);
    const res = {
      statusCode: 0,
      headers: {},
      body: "",
      writeHead(status, headers) {
        this.statusCode = status;
        Object.assign(this.headers, headers || {});
      },
      end(chunk) {
        if (chunk !== undefined) this.body += String(chunk);
      },
    };
    await route.handler({ method: "GET", url }, res);
    return res;
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
  return {
    dir,
    root,
    fiber,
    tools: root.get("tools"),
    prompts: root.get("systemPrompt"),
    web: root.get("webServer"),
  };
}

test("plugin mounts into a real Cordis application", async () => {
  const { tools, prompts } = await mountHost();
  assert.deepEqual(
    tools.registered.map((tool) => tool.name).sort(),
    [
      "context_prism_build",
      "context_prism_dashboard",
      "context_prism_evaluate",
      "context_prism_ingest",
      "context_prism_report",
      "context_prism_status",
      "context_prism_summarize",
    ],
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
  assert.equal(root.get("tools").registered.length, 7, "the plugin still mounts without systemPrompt");
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

// ---------------------------------------------------------------------------
// HTTP routes: one host, two projects
// ---------------------------------------------------------------------------

/** Seed a project root with one file and ingest it through the mounted tool. */
async function seedProject(tools, root) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "notes.md"), `Project marker for ${root}.`, "utf8");
  const ingest = tools.registered.find((tool) => tool.name === "context_prism_ingest");
  await ingest.execute(
    { path: "notes.md", backend: "json", index: ".lce/host.json" },
    { agent: { session: { header: { cwd: root } } } },
  );
}

test("one host serves two different project roots, chosen per request", async () => {
  const { dir, tools, web } = await mountHost();
  const rootA = join(dir, "project-a");
  const rootB = join(dir, "project-b");
  await seedProject(tools, rootA);
  await seedProject(tools, rootB);

  const first = await web.request(`/context-prism/report?project=${encodeURIComponent(rootA)}`);
  const second = await web.request(`/context-prism/report?project=${encodeURIComponent(rootB)}`);
  const firstAgain = await web.request(`/context-prism/report?project=${encodeURIComponent(rootA)}`);

  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["Content-Type"], "application/json; charset=utf-8");
  const reportA = JSON.parse(first.body);
  const reportB = JSON.parse(second.body);

  assert.equal(reportA.project.root, rootA);
  assert.equal(reportA.project.source, "query");
  assert.equal(reportB.project.root, rootB);
  assert.equal(reportB.project.source, "query");
  assert.equal(reportA.index.path, join(rootA, ".lce", "host.json"));
  assert.equal(reportB.index.path, join(rootB, ".lce", "host.json"));
  assert.notEqual(reportA.index.path, reportB.index.path, "each request reads its own project's index");
  assert.equal(reportA.counts.total, 1);
  assert.equal(reportB.counts.total, 1);

  // No request may observe a project a different request selected.
  assert.equal(JSON.parse(firstAgain.body).project.root, rootA);
  assert.equal(JSON.parse(firstAgain.body).index.path, reportA.index.path);
});

test("a bad project parameter is a JSON 400, not a wrong project", async () => {
  const { web } = await mountHost();

  const relative = await web.request("/context-prism/report?project=relative/path");
  assert.equal(relative.statusCode, 400);
  assert.equal(JSON.parse(relative.body).error.code, "BAD_PROJECT");

  const missing = await web.request("/context-prism/report?project=/definitely/not/a/real/project");
  assert.equal(missing.statusCode, 400);
  assert.equal(JSON.parse(missing.body).error.code, "BAD_PROJECT");
});

test("the configured default project root is the fallback after the query parameter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lce-default-root-"));
  const configured = join(dir, "configured");
  mkdirSync(configured, { recursive: true });
  const { web } = await mountHost({ defaultProjectRoot: configured });

  const fromConfig = await web.request("/context-prism/report");
  const body = JSON.parse(fromConfig.body);
  assert.equal(fromConfig.statusCode, 200);
  assert.equal(body.project.root, configured);
  assert.equal(body.project.source, "config");

  // The query parameter still wins.
  const explicit = join(dir, "explicit");
  mkdirSync(explicit, { recursive: true });
  const fromQuery = await web.request(`/context-prism/report?project=${encodeURIComponent(explicit)}`);
  assert.equal(JSON.parse(fromQuery.body).project.root, explicit);
  assert.equal(JSON.parse(fromQuery.body).project.source, "query");
});

test("the dashboard route renders the same report as HTML", async () => {
  const { dir, web } = await mountHost();
  const response = await web.request(`/context-prism/dashboard?project=${encodeURIComponent(dir)}`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Content-Type"], "text/html; charset=utf-8");
  assert.match(response.body, /ContextPrism Dashboard/);
  assert.match(response.body, /Total chunks:/);
});

test("the report route never emits HTML or chunk content", async () => {
  const { dir, tools, web } = await mountHost({ autoIndexFiles: false });
  const root = join(dir, "content-project");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "secret.md"), "The launch code is violet-orchid-42.", "utf8");
  const ingest = tools.registered.find((tool) => tool.name === "context_prism_ingest");
  await ingest.execute(
    { path: "secret.md", backend: "json", index: ".lce/host.json" },
    { agent: { session: { header: { cwd: root } } } },
  );

  const response = await web.request(`/context-prism/report?project=${encodeURIComponent(root)}`);
  assert.equal(response.statusCode, 200);
  assert.ok(!response.body.includes("<html"), "the report route must not return HTML");
  assert.doesNotMatch(response.body, /violet-orchid-42/, "the report is an audit view, not a content reader");
});

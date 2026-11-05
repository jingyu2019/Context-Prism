# ContextPrism Usage

After installing ContextPrism in a DSH profile, the agent can call seven tools, and the
web client shows one panel. The panel and `context_prism_report` read the same JSON, so
what you see in the UI is what a script gets.

## Session scope (v0.9)

A window is scoped to the session that asked for it. You do not pass anything for that
to happen: the prompt-context provider derives the scope from `agent.session` and passes
it as `buildContext({ scope })`.

Rules worth knowing:

- `history` / `trajectory` belong to the session that captured them. Another session in
  the same workspace will not see them, even though both share `.lce/index.db`.
- `preference` / `code` / `file` are project-wide: switching sessions does not lose them.
- Imported JSONL corpora have no owner, so they stay project-wide. That is deliberate,
  not an isolation hole.
- `context_prism_build` accepts an optional `session` argument for callers that are not
  sessions (batch jobs, tests). It is **not** a cross-session read: asking for a session
  other than your own throws.

## DSH Tools

### `context_prism_ingest`

```json
{
  "path": "docs",
  "kind": "file",
  "index": ".lce/index.db",
  "backend": "auto",
  "incremental": true
}
```

Incremental directory ingestion is bounded: at most 1 MiB per file, 32 MiB per batch and
20000 files; symlinks are skipped unless `followSymlinks` is enabled, and `.lceignore`
patterns are honoured. Skips are reported in the output rather than silently dropped.

### `context_prism_build`

```json
{
  "query": "How should I assemble a dynamic context window with local RAG?",
  "maxTokens": 4000,
  "reservedOutputTokens": 800,
  "index": ".lce/index.db",
  "backend": "auto"
}
```

`report.scope` in the result tells you which session the window was scoped to
(`null` = whole project index).

### `context_prism_report` (structured; what the panel renders)

```json
{
  "project": "/abs/path/to/workspace",
  "index": ".lce/index.db",
  "backend": "auto"
}
```

Returns `{"output": "<human text>", "report": { … }}` with:

- `counts.byKind` — all six kinds, zero-filled
- `counts.byScope` — `sessionScoped` / `projectScoped` / `unowned`
- `sessions[]` — one row per session: history/trajectory counts, cursor, timestamps
- `injection` — mode, injections, skippedEmpty, reentries, last, lastError
- `host` — version / target / supported / reason
- `diagnostics.search` — FTS errors, LIKE fallbacks

It never contains chunk content, query text, or ids of session-scoped chunks: a report is
an audit view, not a cross-session read.

### `context_prism_status`

The human-readable view of the same report (same numbers, plus a sample of project
sources). Kept because it reads well in a terminal or a transcript.

### `context_prism_evaluate`

```json
{
  "queries": "[{\"id\":\"q1\",\"query\":\"rollback procedure\",\"goldChunkIds\":[\"ops.md#0\"]}]",
  "k": 10,
  "routes": "[\"no-injection\",\"bm25-only\",\"hybrid\"]"
}
```

Reports Recall@K, MRR, nDCG@10, token efficiency and a "hit rate" line per route.
Omit `queries` to evaluate the committed `bench/` fixture instead (41 labelled queries
over 41 blocks). A legacy `{query, expected}` label is still accepted: the label is
resolved to gold chunk ids once, then the metrics compare ids — a substring match never
decides a hit.

The committed baseline, for reference:

| route | Recall@10 | MRR | nDCG@10 |
| --- | --- | --- | --- |
| `no-injection` | 0.000 | 0.000 | 0.000 |
| `bm25-only` | 0.976 | 0.785 | 0.833 |
| `hybrid` | 0.976 | 0.758 | 0.812 |

`hybrid` does **not** beat `bm25-only` on this fixture. See
[ROADMAP-REVIEW §2.9](analysis/ROADMAP-REVIEW.md) for why that is the honest reading.

### `context_prism_dashboard`

Writes `.lce/dashboard.html` from the same Report. Optional: the panel in the DSH web
shell is the normal way to look at this state.

### `context_prism_summarize`

Summarize a block of text with the configured LLM, falling back to local extractive
compression when no key is configured.

## HTTP routes

```bash
# structured JSON (never HTML)
curl 'http://127.0.0.1:<port>/context-prism/report?project=/abs/path/to/workspace'

# HTML rendered from the same report
curl 'http://127.0.0.1:<port>/context-prism/dashboard?project=/abs/path/to/workspace'
```

Project resolution is per request: `?project=` (must be an absolute existing directory)
→ the `defaultProjectRoot` config → `process.cwd()`. An unusable `project` yields
`400 {"error":{"code":"BAD_PROJECT",...}}` rather than silently serving a different
project. The response's `project.source` says which rule applied.

## JavaScript API

```js
import { LocalContextEngine } from "./engine/engine.js";
import { SourceKind } from "./engine/models.js";

const engine = new LocalContextEngine({ storagePath: ".lce/index.db", backend: "sqlite" });
engine.addText({ content: "User prefers concise Chinese.", source: "pref.md", kind: SourceKind.PREFERENCE, priority: 10 });
engine.addHistoryJsonl("history.jsonl");
engine.addTrajectoryJsonl("trajectory.jsonl");

// scope: one session id, or null for the whole project index.
const window = engine.buildContext({
  query: "Summarize the project context",
  maxTokens: 4000,
  reservedOutputTokens: 800,
  scope: "session-abc",
});
console.log(window.text, window.report().scope);
```

Only one scope source is allowed: pass `scope` here or set `retrievalConfig.scope`, never
both with different values (that throws a `TypeError`), because guessing which one wins is
how cross-session leaks happen.

## Evaluator API

```js
import { evaluateRetrieval, loadBenchFixture, ROUTES } from "./engine/evaluation.js";

const { chunks, queries } = loadBenchFixture();
const engine = new LocalContextEngine({});
engine.addChunks(chunks);
const report = await evaluateRetrieval({ index: engine.index, queries, routes: ROUTES });
console.log(report.byRoute["bm25-only"].recallAtK);
```

## Tests

```bash
npm test               # 104 tests
npm run test:compat    # the DSH rc.5 contract suite only
```

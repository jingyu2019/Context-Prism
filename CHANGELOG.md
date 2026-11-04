# Changelog

## [0.8.0] - 2026-11-04

**Compatibility release for DeepSeek Harness 0.2.1-rc.5.** v0.7.0 loaded but its
headline feature — automatic context injection — never fired. Everything below was
verified against the shipped 0.2.1-rc.5 runtime, not against its documentation.

### Fixed

- **Automatic injection was a silent no-op.** The default `backend: "auto"` opens a
  fresh empty SQLite index, `buildContext()` returned an empty window, and the guard
  `if (window.text)` dropped it without a trace. An empty index now counts as an
  observable skip (`context_prism_status` reports it) instead of disappearing.
- **Session messages were never captured.** DSH 0.2.1 delivers `user/message` as the
  message itself (`event.data`), with block-array content
  (`[{type:"text", text}]`). Reading `event.data.message.content` as a string returned
  `""` for every message, so capture stored nothing.
- **Injection used the wrong seam.** Appending a message inside `agent/pre-step`
  competed with the loop's own runtime-context projection. The plugin now contributes
  `ctx.systemPrompt.context()` (the same primitive `dsh-time-context` uses), and falls
  back to the pre-step path on hosts that do not provide it.
- **Retrieval scored by array position.** `bm25RankScore()` used `indexOf()`, so the
  first row always scored `1.0` regardless of content and the real BM25 score computed
  in `LocalIndex.search()` was discarded. Both indexes now expose `searchWithScores()`;
  BM25 and FTS5 ranks are normalized onto one scale. This also makes
  `context_prism_evaluate` meaningful again.
- **Packing ignored separator cost.** `compressItems()` checked the raw chunk-token sum
  while `ContextSection` renders a blank line plus header per item, so a "full" section
  exceeded its budget.
- **Lifecycle leaked.** Watchers, debounce timers, and open SQLite handles lived in
  module-level maps with no disposal path; they now close with the plugin fiber.
- **Peer ranges did not match any real host.** `^0.1.0-rc.6` cannot be satisfied by
  `0.2.1-rc.5` under semver.

### Added

- `engine/session_events.js` — host-neutral event reading (probes `session.events`,
  `snapshotEvents()`, `eventAt()`) and projection of message/tool events into chunks.
- `engine/version.js` — prerelease-aware version comparison and a supported-host window;
  `context_prism_status` reports the host version and injection mode.
- Persistent per-session capture cursor in the index (`session_cursor` kind, never
  retrievable), so capture survives a restart and is idempotent.
- `disposeAll()` teardown wired through `ctx.effect`.
- 27 new tests, including a suite that mounts the plugin into a real Cordis
  application (`test/host.test.js`) and contract tests for the rc.5 tool/param DSL
  (`test/compat.test.js`). Suite: 44 tests, green on Node 24.21.0 and Node 26.

### Changed

- CI matrix: Node 22 and 24.
- Client bundle requires only `react`, declared as its `dsh.client.inject` seed.
- `cordis.patch.yml` lists the defaults explicitly instead of relying on code defaults.

### Analysis

- `docs/analysis/graph-report.md` — graphify knowledge graph (579 nodes, 1 312 edges).
- `docs/analysis/ROADMAP-REVIEW.md` — optimizations and an assessment of the §13 roadmap.

## [0.7.0] - 2026-08-18

- Add DSH Web client footer action that opens the ContextPrism dashboard.
- Add host HTTP route `/context-prism/dashboard` serving the live HTML dashboard.

## [0.6.0] - 2026-08-18

- Add real-time file watching with debounced re-index (`fileWatch` / `watchDebounceMs`).
- Add A/B retrieval evaluation tool (`context_prism_evaluate`).

## [0.5.0] - 2026-08-18

- Add standalone HTML dashboard generation (`context_prism_dashboard`).

## [0.4.0] - 2026-08-18

- Add local semantic retrieval (hash n-gram embedding + cosine similarity).
- Add optional LLM summarization with extractive fallback.
- Add `context_prism_status` and `context_prism_summarize` tools.
- Add `llmSummarization` / `summarizationModel` / `summaryMaxTokens` config.

## [0.3.0] - 2026-08-18

- Add automatic session history / trajectory capture.
- Add automatic project file incremental indexing.
- Add automatic context injection before each LLM request.
- Add `autoInject` / `autoIndexFiles` / `autoMaxTokens` / `autoReservedTokens` / `autoIndexIntervalMs` config.

## [0.2.0] - 2026-08-18

- Add DSH workspace / project-level index storage (`.lce/index.db`).
- Add in-process JavaScript port of ContextPrism core.
- Add `context_prism_build` and `context_prism_ingest` DSH tools.
- Add SQLite FTS5 + BM25 retrieval, compression, prioritization, caches, incremental ingest.
- Add DeepSeek / OpenAI compatible payload adapters.
- Add automatic session history / trajectory capture.
- Add automatic project file incremental indexing.
- Add automatic context injection before each LLM request.

## [0.1.0] - 2026-08-18

- Initial Local Context Engine prototype.

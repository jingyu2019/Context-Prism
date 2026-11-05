// Core data structures for the Local Context Engine (JS port).

export const SourceKind = Object.freeze({
  HISTORY: "history",
  CODE: "code",
  FILE: "file",
  PREFERENCE: "preference",
  TRAJECTORY: "trajectory",
  /** Per-session capture cursor; never retrieved, never rendered into a window. */
  SESSION_CURSOR: "session_cursor",
});

/** Kinds that may appear in a context window, in section order. */
export const RETRIEVABLE_KINDS = Object.freeze([
  SourceKind.PREFERENCE,
  SourceKind.HISTORY,
  SourceKind.TRAJECTORY,
  SourceKind.CODE,
  SourceKind.FILE,
]);

/**
 * Kinds that belong to one session: a `history` / `trajectory` chunk captured
 * from session A is A's private memory, not the project's.
 */
export const SESSION_SCOPED_KINDS = Object.freeze([SourceKind.HISTORY, SourceKind.TRAJECTORY]);

/** Kinds that belong to the project and are visible to every session. */
export const PROJECT_SCOPED_KINDS = Object.freeze([SourceKind.PREFERENCE, SourceKind.CODE, SourceKind.FILE]);

/**
 * The session that owns this chunk, or null when the chunk belongs to the project.
 *
 * `metadata.sessionId` is authoritative when present; otherwise the capture-time
 * `session:<id>` source convention decides; anything else (an imported JSONL
 * corpus, seed data) is unowned and therefore project-wide.
 *
 * @param {object|null|undefined} chunk
 * @returns {string|null}
 */
export function sessionScopeOf(chunk) {
  const fromMetadata = chunk?.metadata?.sessionId;
  if (typeof fromMetadata === "string" && fromMetadata.trim() !== "") return fromMetadata.trim();
  const fromSource = typeof chunk?.source === "string" ? /^session:(.+)$/.exec(chunk.source) : null;
  return fromSource ? fromSource[1] : null;
}

/**
 * Normative visibility rule — the only definition of "may this chunk appear in
 * this window". Every read path goes through it; `retrieve()` is the choke
 * point that applies it before ranking.
 *
 * @param {object|null|undefined} chunk
 * @param {string|null} scope - normalized session scope; null means whole index.
 * @returns {boolean}
 */
export function isVisibleInScope(chunk, scope) {
  if (!chunk) return false;
  if (chunk.kind === SourceKind.SESSION_CURSOR) return false; // control record: never visible
  if (scope === null || scope === undefined) return true; // unscoped: whole project index
  if (!SESSION_SCOPED_KINDS.includes(chunk.kind)) return true; // project-scoped: always visible
  const owner = sessionScopeOf(chunk);
  return owner === null || owner === scope; // foreign session: excluded
}

export class Chunk {
  constructor({ id, source, kind, content, metadata = {}, timestamp = null, priority = 0, tokens = 0 }) {
    this.id = id;
    this.source = source;
    this.kind = kind;
    this.content = content;
    this.metadata = metadata;
    this.timestamp = timestamp ?? Date.now() / 1000;
    this.priority = priority;
    this.tokens = tokens > 0 ? tokens : estimateTokens(content);
  }
}

export class RetrievedItem {
  constructor({ chunk, score = 0, reason = "" }) {
    this.chunk = chunk;
    this.score = score;
    this.reason = reason;
  }
}

export class ContextSection {
  constructor({ title, content = "", tokens = 0, items = [], compressed = false }) {
    this.title = title;
    this.content = content;
    this.tokens = tokens;
    this.items = items;
    this.compressed = compressed;
  }
}

export class ContextWindow {
  constructor({
    query,
    sections = [],
    maxTokens = 0,
    reservedOutputTokens = 0,
    tokenBudget = 0,
    totalTokens = 0,
    omittedCount = 0,
    omittedTokens = 0,
    createdAt = Date.now() / 1000,
    scope = null,
  }) {
    this.query = query;
    // The normalized scope that produced this window: null = whole-index
    // (CLI/tests), otherwise the one session whose history/trajectory may appear.
    this.scope = scope;
    this.sections = sections;
    this.maxTokens = maxTokens;
    this.reservedOutputTokens = reservedOutputTokens;
    this.tokenBudget = tokenBudget;
    this.totalTokens = totalTokens;
    this.omittedCount = omittedCount;
    this.omittedTokens = omittedTokens;
    this.createdAt = createdAt;
  }

  get text() {
    const parts = [];
    for (const section of this.sections) {
      if (!section.content) continue;
      const header = `### ${section.title}` + (section.compressed ? " [compressed]" : "");
      parts.push(header);
      parts.push(section.content);
    }
    return parts.length > 0 ? parts.join("\n\n") : "";
  }

  asMessages(systemPrompt = null) {
    let systemContent = systemPrompt || "You are a helpful assistant.";
    const contextText = this.text;
    if (contextText) {
      systemContent = `${systemContent}\n\n# Local Context\n\n${contextText}`;
    }
    return [
      { role: "system", content: systemContent },
      { role: "user", content: this.query },
    ];
  }

  report() {
    return {
      query: this.query,
      maxTokens: this.maxTokens,
      reservedOutputTokens: this.reservedOutputTokens,
      tokenBudget: this.tokenBudget,
      totalTokens: this.totalTokens,
      omittedCount: this.omittedCount,
      omittedTokens: this.omittedTokens,
      scope: this.scope,
      sections: this.sections.map((section) => ({
        title: section.title,
        tokens: section.tokens,
        compressed: section.compressed,
        items: section.items.map((item) => ({
          id: item.chunk.id,
          source: item.chunk.source,
          kind: item.chunk.kind,
          score: Math.round(item.score * 10000) / 10000,
          tokens: item.chunk.tokens || estimateTokens(item.chunk.content),
          reason: item.reason,
        })),
      })),
    };
  }
}

export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of String(text)) {
    if (ch >= "\u4e00" && ch <= "\u9fff") cjk += 1;
  }
  const other = text.length - cjk;
  if (other === 0) return cjk;
  return cjk + Math.ceil(other / 4);
}

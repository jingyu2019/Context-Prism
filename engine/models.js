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
  constructor({ query, sections = [], maxTokens = 0, reservedOutputTokens = 0, tokenBudget = 0, totalTokens = 0, omittedCount = 0, omittedTokens = 0, createdAt = Date.now() / 1000 }) {
    this.query = query;
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

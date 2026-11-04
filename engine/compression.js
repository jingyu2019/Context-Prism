// Compression strategies for fitting more context into a finite window.

import { estimateTokens } from "./models.js";
import { splitSentences, termFrequencies, tokenize } from "./text_utils.js";

/**
 * Tokens a section separator costs once two items are packed together.
 * `ContextSection` joins items with a blank line and each item is rendered with
 * its own header, none of which `chunk.tokens` accounts for. Ignoring it made
 * the assembled section exceed the budget it was packed against.
 */
export const PACKING_SEPARATOR_TOKENS = 2;

/** Token cost of `count` packed items, separators included. */
export function packedTokens(count) {
  return count <= 0 ? 0 : (count - 1) * PACKING_SEPARATOR_TOKENS;
}

export class PackedItem {
  constructor({ item, content, tokens, compressed = false }) {
    this.item = item;
    this.content = content;
    this.tokens = tokens;
    this.compressed = compressed;
  }
}

export class CompressionResult {
  constructor({ packed = [], omittedCount = 0, omittedTokens = 0, omittedIds = [] } = {}) {
    this.packed = packed;
    this.omittedCount = omittedCount;
    this.omittedTokens = omittedTokens;
    this.omittedIds = omittedIds;
  }
}

export function compressItems(items, budgetTokens, query = "", minChunkTokens = 24) {
  const ordered = [...items].sort((a, b) => b.score - a.score);
  const packed = [];
  const omittedIds = [];
  let omittedTokens = 0;
  let used = 0;

  for (const item of ordered) {
    const content = item.chunk.content;
    const tokens = item.chunk.tokens || estimateTokens(content);
    const separator = packed.length > 0 ? PACKING_SEPARATOR_TOKENS : 0;
    if (used + separator + tokens <= budgetTokens) {
      packed.push(new PackedItem({ item, content, tokens, compressed: false }));
      used += separator + tokens;
      continue;
    }

    const remaining = budgetTokens - used - separator;
    if (remaining >= minChunkTokens) {
      const [compressed, compressedTokens] = compressChunkToFit(content, remaining, query);
      if (compressedTokens > 0) {
        packed.push(new PackedItem({ item, content: compressed, tokens: compressedTokens, compressed: true }));
        used += separator + compressedTokens;
        continue;
      }
    }

    omittedIds.push(item.chunk.id);
    omittedTokens += tokens;
  }

  return new CompressionResult({ packed, omittedCount: omittedIds.length, omittedTokens, omittedIds });
}

export async function compressItemsAsync(items, budgetTokens, query = "", { minChunkTokens = 24, summarizer = null } = {}) {
  const ordered = [...items].sort((a, b) => b.score - a.score);
  const packed = [];
  const omittedIds = [];
  let omittedTokens = 0;
  let used = 0;

  for (const item of ordered) {
    const content = item.chunk.content;
    const tokens = item.chunk.tokens || estimateTokens(content);
    const separator = packed.length > 0 ? PACKING_SEPARATOR_TOKENS : 0;
    if (used + separator + tokens <= budgetTokens) {
      packed.push(new PackedItem({ item, content, tokens, compressed: false }));
      used += separator + tokens;
      continue;
    }

    const remaining = budgetTokens - used - separator;
    if (remaining >= minChunkTokens) {
      let compressed = "";
      if (summarizer) {
        compressed = await summarizer(content, remaining);
      }
      if (!compressed) {
        [compressed] = compressChunkToFit(content, remaining, query);
      }
      const compressedTokens = estimateTokens(compressed);
      if (compressedTokens > 0) {
        packed.push(new PackedItem({ item, content: compressed, tokens: compressedTokens, compressed: true }));
        used += separator + compressedTokens;
        continue;
      }
    }

    omittedIds.push(item.chunk.id);
    omittedTokens += tokens;
  }

  return new CompressionResult({ packed, omittedCount: omittedIds.length, omittedTokens, omittedIds });
}

export function compressChunkToFit(content, maxTokens, query = "") {
  if (maxTokens <= 0) return ["", 0];
  if (estimateTokens(content) <= maxTokens) return [content, estimateTokens(content)];

  const extractive = extractiveCompress(content, maxTokens, query);
  if (extractive) return [extractive, estimateTokens(extractive)];

  return truncateText(content, maxTokens);
}

export function truncateText(content, maxTokens) {
  if (maxTokens <= 0) return ["", 0];
  if (estimateTokens(content) <= maxTokens) return [content, estimateTokens(content)];
  const parts = content.split(/(?<=\n)/);
  const out = [];
  let used = 0;
  for (const part of parts) {
    const partTokens = estimateTokens(part);
    if (used + partTokens > maxTokens) {
      const remaining = maxTokens - used;
      if (remaining > 8 && part) {
        const cut = cutByTokens(part, remaining);
        out.push(cut);
        used += estimateTokens(cut);
      }
      break;
    }
    out.push(part);
    used += partTokens;
  }
  let text = out.join("").trimEnd();
  if (!text) text = cutByTokens(content, maxTokens);
  return [text, estimateTokens(text)];
}

function extractiveCompress(content, maxTokens, query = "") {
  const sentences = splitSentences(content);
  if (sentences.length <= 1) return "";
  const queryFreqs = query ? termFrequencies(tokenize(query)) : {};
  const scored = [];
  for (let idx = 0; idx < sentences.length; idx += 1) {
    const sentence = sentences[idx];
    const freqs = termFrequencies(tokenize(sentence));
    let overlap = 0;
    for (const [term, qf] of Object.entries(queryFreqs)) {
      overlap += (freqs[term] || 0) * qf;
    }
    const lengthBonus = Math.min(1, sentence.length / 200);
    const positionBonus = idx === 0 ? 1 : 0.6;
    const score = overlap + lengthBonus * 0.5 + positionBonus;
    scored.push({ score, idx, sentence });
  }
  scored.sort((a, b) => b.score - a.score);
  const chosen = [];
  let used = 0;
  for (const { idx, sentence } of scored) {
    const sentenceTokens = estimateTokens(sentence);
    if (used + sentenceTokens > maxTokens) continue;
    chosen.push({ idx, sentence });
    used += sentenceTokens;
  }
  if (chosen.length === 0) return "";
  chosen.sort((a, b) => a.idx - b.idx);
  return chosen.map((entry) => entry.sentence).join("\n");
}

export function buildOmittedNote(omittedCount, omittedTokens, maxTokens = 80) {
  if (omittedCount <= 0) return "";
  let note =
    `[Local Context Engine] ${omittedCount} lower-priority item(s) ` +
    `(~${omittedTokens} tokens) were omitted to stay within the context budget. ` +
    "Ask the user or use retrieval if any omitted detail is needed.";
  if (estimateTokens(note) > maxTokens) {
    note =
      `[Local Context Engine] ${omittedCount} lower-priority item(s) ` +
      `(~${omittedTokens} tokens) omitted for budget.`;
  }
  return note;
}

function cutByTokens(text, maxTokens) {
  if (maxTokens <= 0) return "";
  const out = [];
  let used = 0;
  for (const ch of String(text)) {
    const cost = ch >= "\u4e00" && ch <= "\u9fff" ? 1 : 0.25;
    if (used + cost > maxTokens) break;
    out.push(ch);
    used += cost;
  }
  return out.join("").trimEnd();
}

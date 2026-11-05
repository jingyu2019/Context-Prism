// Lightweight text utilities used by retrieval and compression.
//
// Tokenization rules (v0.9, see docs/SPEC-SESSION-ISOLATION.md §4.6 / D9):
//   - ASCII runs  -> one lowercased token per `[A-Za-z0-9_]+` run (unchanged)
//   - CJK runs    -> overlapping bigrams `run[i..i+1]`, in text order; a run of
//                    length 1 emits the single character
//
// Why bigrams: a CJK "word" is not space-delimited and a whole run as one token
// means a short query can only match an identically-sized run. Overlapping
// bigrams give sub-string granularity in both directions (query and document)
// at the cost of a bigger term space.

const TOKEN_RE = /[a-zA-Z0-9_]+|[\u4e00-\u9fff]+/g;
const CJK_RE = /^[\u4e00-\u9fff]+$/;

function isCjkRun(piece) {
  return CJK_RE.test(piece);
}

export function tokenize(text) {
  const tokens = [];
  for (const match of String(text).matchAll(TOKEN_RE)) {
    const piece = match[0];
    if (!isCjkRun(piece)) {
      tokens.push(piece.toLowerCase());
      continue;
    }
    const length = piece.length;
    if (length === 1) {
      tokens.push(piece);
      continue;
    }
    for (let index = 0; index + 1 < length; index += 1) {
      tokens.push(piece.slice(index, index + 2));
    }
  }
  return tokens;
}

export function splitSentences(text) {
  return String(text)
    .split(/(?<=[。！？!?.])\s*|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function termFrequencies(tokens) {
  const freqs = {};
  for (const token of tokens) {
    freqs[token] = (freqs[token] || 0) + 1;
  }
  return freqs;
}

export function cosineSimilarity(a, b) {
  if (!a || !b) return 0;
  const common = Object.keys(a).filter((key) => key in b);
  let dot = 0;
  for (const key of common) dot += a[key] * b[key];
  const normA = Math.sqrt(Object.values(a).reduce((sum, v) => sum + v * v, 0));
  const normB = Math.sqrt(Object.values(b).reduce((sum, v) => sum + v * v, 0));
  if (normA === 0 || normB === 0) return 0;
  return dot / (normA * normB);
}

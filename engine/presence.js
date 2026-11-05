// Presence ground truth for prompt injection.
//
// The prompt-context contribution runs once per agent step, and it used to
// re-state material the outgoing request already carried: on a fixed token
// budget every step paid for context the model could already read.
//
// The honest answer to "is this text already in the request?" is the host's
// live derived-message surface (`Session.deriveMessages()`), never the index.
// The index is append-only memory of everything ever captured; the surface is
// what the model will actually see this step. A compaction `replace` deletes
// the nodes it shadows, so one chunk can be both "in the index" and "absent
// from the request" — and that chunk is exactly the one worth injecting.
//
// This module owns only the text comparison. Whether a hit means "drop it" or
// "keep it" is the caller's decision: duplicate chunk in the request -> drop;
// absent chunk -> keep, because it is either project material or history the
// request lost.

/**
 * Sentinel placed between messages in the haystack.
 *
 * It is not whitespace, so `normalizeForPresence` never removes it, and it
 * cannot occur inside normalized text. A chunk therefore can never match by
 * straddling two neighbouring messages.
 */
const SEPARATOR = "\u0000";

/** Default haystack ceiling: roughly 4 MB of characters. */
export const DEFAULT_MAX_HAYSTACK_CHARS = 4_000_000;

/**
 * Canonical form for presence comparison: lowercase, whitespace runs collapsed
 * to one space, trimmed.
 *
 * Both sides go through it, so a live message that was re-wrapped and a chunk
 * stored with different spacing still compare equal. This is exactly the three
 * steps the contract names; tolerating the plugin's own `user:` /
 * `[kind | source]` decoration is a *chunk-side* extra, applied in
 * `candidatesOf`, because it must never weaken how the live request itself is
 * read.
 *
 * @param {unknown} text
 * @returns {string} normalized text ("" for null/undefined)
 */
export function normalizeForPresence(text) {
  if (text == null) return "";
  return String(text).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The `[kind | source]` header `ContextWindow` renders above a section item.
 * Only a bracketed token at the very start, followed by whitespace or the end
 * of the line, qualifies — so a Markdown link (`[text](url)`) is left alone.
 */
const RENDERED_HEADER = /^\[[^\]\n]{1,200}\][ \t]*$/;
const RENDERED_HEADER_WITH_BODY = /^\[[^\]\n]{1,200}\][ \t]+/;

/** The `user:` / `assistant:` / `tool:` label capture stores with a message. */
const AUTHOR_LABEL = /^(?:user|assistant|developer|system|tool)[ \t]*:[ \t]*/i;

/**
 * Drop the plugin's own formatting so a stored chunk can be compared against a
 * live message.
 *
 * Capture stores `user: <text>` for a message and `[tool/result] <text>` for a
 * tool result; rendering prepends `[kind | source]`. None of those prefixes are
 * part of what the model reads as the message body, so they must not decide
 * presence. Runs on normalized text, where the rendered header's newline is
 * already a single space.
 *
 * @param {string} normalized - output of {@link normalizeForPresence}
 * @returns {string}
 */
function stripFormattingPrefixes(normalized) {
  if (!normalized) return "";
  let out = normalized;
  if (RENDERED_HEADER.test(out)) return "";
  out = out.replace(RENDERED_HEADER_WITH_BODY, "");
  out = out.replace(AUTHOR_LABEL, "");
  return out.trim();
}

/**
 * Every form of one chunk's text worth searching for, most specific first.
 *
 * Two candidates, not one: the stripped body (which is what a prefix match
 * needs) and the raw normalized text (which is what a caller that stores no
 * label needs). Empty candidates are dropped, and a blank chunk therefore has
 * no candidate at all — blank text is never "present".
 *
 * @param {unknown} text
 * @returns {string[]}
 */
function candidatesOf(text) {
  const normalized = normalizeForPresence(text);
  if (!normalized) return [];
  const stripped = stripFormattingPrefixes(normalized);
  if (!stripped || stripped === normalized) return [normalized];
  return [stripped, normalized];
}

/** Word characters for the boundary rule (lowercase text, plus CJK). */
const WORD_CHAR = /[a-z0-9_\u4e00-\u9fff]/;
/** Word runs used by the "substantial token" rule. */
const TOKEN_RUNS = /[a-z0-9]+|[\u4e00-\u9fff]+/g;
/** An ASCII run this long is specific enough to mean something. */
const MIN_ASCII_TOKEN_CHARS = 4;
/** Two CJK characters carry as much signal as four Latin ones. */
const MIN_CJK_TOKEN_CHARS = 2;

/**
 * Does this needle contain at least one word specific enough to be evidence?
 *
 * A short common body — "ok", "the", "fix bug" — occurs inside unrelated live
 * text often enough that matching it would withhold information the model does
 * not actually have: the one false-positive direction the requirement forbids.
 * Requiring one run of >= 4 ASCII (or >= 2 CJK) characters keeps that out, and
 * when in doubt the caller keeps the chunk, i.e. injects it.
 *
 * @param {string} needle - normalized candidate text.
 * @returns {boolean}
 */
function hasSubstantialToken(needle) {
  for (const run of needle.match(TOKEN_RUNS) ?? []) {
    const isLatin = /^[a-z0-9]+$/.test(run);
    if (run.length >= (isLatin ? MIN_ASCII_TOKEN_CHARS : MIN_CJK_TOKEN_CHARS)) return true;
  }
  return false;
}

/** @param {string} char - single character, possibly "". */
function isWordChar(char) {
  return char !== "" && WORD_CHAR.test(char);
}

/**
 * Find `needle` in `text` without matching inside a longer word.
 *
 * A hit must start and end on a word boundary. The one exception is a hit that
 * begins at the very start of the message: a chunk captured from that message
 * is a *prefix* of it — the 8000-char per-chunk truncation cuts mid-word — and
 * a literal prefix is genuinely present even when the cut leaves the needle's
 * last character inside the message's next word. Without that exception the
 * truncation case (the main long-history case) would silently stop matching.
 *
 * @param {string} text - normalized haystack or single message.
 * @param {string} needle - normalized, non-empty chunk text.
 * @returns {boolean}
 */
function matchesWithBoundaries(text, needle) {
  if (text.length === 0 || needle.length === 0) return false;
  const lastStart = text.length - needle.length;
  let from = 0;
  while (from <= lastStart) {
    const at = text.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : text[at - 1];
    const after = text[at + needle.length] ?? "";
    const startsClean = !isWordChar(before) || !isWordChar(needle[0]);
    const endsClean = !isWordChar(after) || !isWordChar(needle[needle.length - 1]);
    const atMessageStart = at === 0 || before === SEPARATOR;
    if (startsClean && (endsClean || atMessageStart)) return true;
    from = at + 1;
  }
  return false;
}

/**
 * THE spelling of one tool invocation, shared by capture and presence.
 *
 * `engine/session_events.js` imports this too — both its message path
 * (`blocksToText`, an assistant message carrying a `tool-call` block) and its
 * event path (`describeEvent`, a `tool/call` event) — so there is exactly one
 * spelling in the codebase:
 *
 *     [tool/call <name>] <serialized arguments>
 *
 * `arguments` follows the host's shape: a string is used as-is (the host
 * carries raw JSON text), anything else is JSON.stringify'd, null is empty.
 *
 * This used to be a documented convention in two places, and they drifted: the
 * message path spelled the block `[tool-call name]` (hyphen, no arguments), so
 * a chunk captured from such a message could never match the live block and was
 * re-injected silently. They now share this function; a test pins both capture
 * paths against it, so a future drift fails loudly instead of silently costing
 * tokens.
 *
 * @param {{name?: unknown, arguments?: unknown}} block - a `tool-call` block or event payload.
 * @returns {string}
 */
export function toolCallText(block) {
  const name = typeof block?.name === "string" && block.name !== "" ? block.name : "tool";
  const args = block?.arguments;
  const serialized = args == null ? "" : typeof args === "string" ? args : JSON.stringify(args);
  return `[tool/call ${name}] ${serialized}`.trim();
}

/**
 * Plain text of a message's `content`, which the host stores either as a string
 * or as block arrays (`[{type:"text", text}]`, `[{type:"tool-call", ...}]`).
 *
 * Text blocks contribute their text. A `tool-call` block contributes its
 * spelled invocation: its arguments ARE in the outgoing request, and the index
 * holds a chunk captured from the same invocation, so ignoring them made that
 * chunk look absent and re-inject it. Image markers stay out: an `[image]`
 * marker is not text the request carries.
 *
 * @param {unknown} content
 * @returns {string}
 */
function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (typeof block === "string") parts.push(block);
      else if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (block && typeof block === "object" && block.type === "tool-call") {
        parts.push(toolCallText(block));
      }
    }
    return parts.join("\n");
  }
  if (typeof content === "object" && typeof content.text === "string") return content.text;
  return "";
}

/**
 * Build the presence index for one live request surface.
 *
 * The haystack is the normalized texts of `messages` joined by a sentinel. It
 * is bounded: once adding a message would pass `maxHaystackChars`, the haystack
 * stops growing and every remaining message is kept for per-message scanning
 * instead, so a pathological transcript can never allocate without limit while
 * presence stays exact.
 *
 * `contains(text)` searches the normalized chunk (with the plugin's own
 * formatting prefixes tolerated). A chunk that is a *prefix* of a live message
 * matches, which is what makes the 8000-char per-chunk truncation harmless.
 *
 * @param {Array<{role?: string, content?: unknown}|string>} messages - live messages.
 * @param {{maxHaystackChars?: number}} [options]
 * @returns {{contains: (text: unknown) => boolean, messageCount: number, chars: number, haystackChars: number, capped: boolean, overflowCount: number, isEmpty: boolean}}
 */
export function buildPresenceIndex(messages, { maxHaystackChars = DEFAULT_MAX_HAYSTACK_CHARS } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const cap =
    Number.isFinite(maxHaystackChars) && maxHaystackChars > 0
      ? Math.floor(maxHaystackChars)
      : DEFAULT_MAX_HAYSTACK_CHARS;

  let haystack = "";
  let messageCount = 0;
  let indexedChars = 0;
  let capped = false;
  const overflow = [];

  for (const message of list) {
    const raw = typeof message === "string" ? message : message?.content;
    const normalized = normalizeForPresence(contentToText(raw));
    if (!normalized) continue;
    messageCount += 1;
    // Every character that went into the comparison counts, whether it landed
    // in the capped haystack or in the per-message overflow: `chars` reports
    // what was actually indexed, not what fit under the cap (R-002).
    indexedChars += normalized.length;

    // Projected size, separators included, so the cap bounds real allocation.
    const projected = haystack.length === 0 ? normalized.length : haystack.length + SEPARATOR.length + normalized.length;
    if (!capped && projected > cap) capped = true;
    if (capped) {
      overflow.push(normalized);
      continue;
    }
    haystack = haystack.length === 0 ? normalized : `${haystack}${SEPARATOR}${normalized}`;
  }

  const isEmpty = haystack.length === 0 && overflow.length === 0;

  return {
    /** @param {unknown} text - candidate chunk text. */
    contains(text) {
      const candidates = candidatesOf(text);
      if (candidates.length === 0) return false;
      for (const needle of candidates) {
        // R-001: a needle that is too short to be evidence never decides
        // presence, and a hit inside a longer word is not a hit at all.
        if (!hasSubstantialToken(needle)) continue;
        if (matchesWithBoundaries(haystack, needle)) return true;
        for (const message of overflow) {
          if (matchesWithBoundaries(message, needle)) return true;
        }
      }
      return false;
    },
    /** Messages that carried text (blank messages are not "present" anything). */
    messageCount,
    /**
     * Total normalized characters that were indexed: haystack text **plus**
     * everything that fell past the cap into the overflow scan. This is the
     * honest "what presence actually read" figure (R-002).
     */
    chars: indexedChars,
    /** Characters held in the capped haystack itself (separators included). */
    haystackChars: haystack.length,
    /** True when the cap forced the per-message fallback. */
    capped,
    /** Messages held outside the haystack and scanned individually. */
    overflowCount: overflow.length,
    /** True when the request carried no text at all. */
    isEmpty,
  };
}

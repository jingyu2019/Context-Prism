// Reading DSH session events without pinning one host release.
//
// Two things change across DSH releases and both used to be hard-coded here:
//
//   1. Where the events live. The current host exposes `session.events`; older
//      builds exposed `session.snapshotEvents()`, and the host has been moving
//      synchronous event reads behind a projection. We probe in capability
//      order and never assume one accessor exists.
//   2. What a message event's payload looks like. `user/message` carries the
//      message itself; assistant/system/developer messages carry
//      `{ message }`. Treating `event.data.content` as a string silently
//      captured nothing, so every message was stored as an empty chunk.
//
// Content is stored as an array of blocks (`[{type:"text", text}]`), so a
// string-only reader loses every event.

import { SourceKind } from "./models.js";
// One spelling for a tool invocation, shared with presence: capture must not
// invent its own marker or the chunk can never match the live block.
import { toolCallText } from "./presence.js";

/**
 * Extract plain text from a message or a content-block array.
 * @param {unknown} content - string, block array, or message object.
 * @returns {string} concatenated text blocks, or "" when there is none.
 */
export function blocksToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block) continue;
      if (typeof block === "string") parts.push(block);
      else if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
      else if (block.type === "image") parts.push("[image]");
      else if (block.type === "tool-call") parts.push(toolCallText(block));
    }
    return parts.join("\n").trim();
  }
  if (typeof content === "object" && typeof content.text === "string") return content.text.trim();
  return "";
}

/**
 * Read the message carried by a message-shaped session event.
 * @param {{type: string, data: any}} event - one session event.
 * @returns {{role?: string, content?: any}|null}
 */
export function messageOf(event) {
  const data = event?.data;
  if (!data) return null;
  if (event.type === "user/message") return data.message ?? data;
  if (data.message) return data.message;
  return null;
}

/**
 * Session id from any of the shapes a host session object has used.
 * @param {object} session - host session.
 * @returns {string|null}
 */
export function sessionIdOf(session) {
  return session?.id || session?.header?.id || null;
}

/**
 * Read session events as an array, whichever accessor this host provides.
 *
 * @param {object} session - host session object.
 * @param {{fromSeq?: number}} options - lowest sequence number to return.
 * @returns {{events: object[], total: number, source: string}}
 */
export function readSessionEvents(session, { fromSeq = 0 } = {}) {
  if (!session) return { events: [], total: 0, source: "none" };

  if (Array.isArray(session.events)) {
    return {
      events: session.events.filter((event) => (Number(event?.seq) || 0) >= fromSeq),
      total: session.events.length,
      source: "session.events",
    };
  }

  if (typeof session.snapshotEvents === "function") {
    try {
      const snapshot = session.snapshotEvents(fromSeq);
      if (Array.isArray(snapshot)) {
        return { events: snapshot, total: Number(session.seq) || snapshot.length, source: "session.snapshotEvents" };
      }
    } catch {
      // Older or projection-backed hosts can reject a snapshot read; fall through.
    }
  }

  if (typeof session.eventAt === "function") {
    const end = Number(session.seq) || 0;
    const events = [];
    for (let seq = fromSeq; seq < end; seq += 1) {
      const event = session.eventAt(seq);
      if (event) events.push(event);
    }
    return { events, total: end, source: "session.eventAt" };
  }

  return { events: [], total: 0, source: "none" };
}

/**
 * Project one session event onto a chunk, or null when it carries nothing worth
 * indexing.
 *
 * Tool events are only worth keeping when they actually say something: an
 * args-only `tool/call` duplicates the assistant message that requested it and
 * costs budget for no extra signal.
 *
 * @param {{type: string, seq: number, data: any}} event - one session event.
 * @param {string} sessionId - owning session.
 * @returns {{id: string, kind: string, content: string, priority: number, author?: string}|null}
 */
export function describeEvent(event, sessionId) {
  const id = (label) => `${sessionId}:${label}:${event.seq}`;
  const type = event?.type;
  if (!type || event.seq == null) return null;

  if (type === "user/message" || type === "assistant/message" || type === "developer/message") {
    const message = messageOf(event);
    const text = blocksToText(message?.content);
    if (!text) return null;
    const author = type === "user/message" ? "user" : type === "assistant/message" ? "assistant" : "developer";
    return { id: id(author), kind: SourceKind.HISTORY, content: `${author}: ${text.slice(0, 8000)}`, priority: 1, author };
  }

  if (type === "system/message") {
    // Re-rendered on every assembly; the newest one is already in the request.
    return null;
  }

  if (type === "tool/result") {
    const text = blocksToText(event.data?.message?.content ?? event.data?.content);
    if (!text) return null;
    return { id: id("tool-result"), kind: SourceKind.TRAJECTORY, content: `[tool/result] ${text.slice(0, 2000)}`, priority: 0.5 };
  }

  if (type === "tool/call") {
    // Same spelling as the message path and presence (presence.js toolCallText):
    // a chunk captured from this event must match the live `tool-call` block.
    const name = event.data?.name || event.data?.tool || "tool";
    const args = event.data?.arguments ?? event.data?.input;
    const content = toolCallText({ name, arguments: args });
    return { id: id("tool-call"), kind: SourceKind.TRAJECTORY, content: content.slice(0, 2000), priority: 0.25 };
  }

  return null;
}

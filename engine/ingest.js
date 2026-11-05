// Ingest helpers for turning raw local data into Chunks (JS port).
//
// v0.9 (docs/SPEC-SESSION-ISOLATION.md §4.4, D11): directory ingestion is
// bounded, symlink-safe and `.lceignore`-aware.
//
//   - `walkFiles()`            — the only directory walk; never follows links,
//                                caps file size / total bytes / file count.
//   - `ingestDirectory()`      — unchanged public shape (`Chunk[]`), now bounded.
//   - `ingestDirectoryIncremental()` — mtime+size diffing over that walk; the
//                                caller (engine.js) owns state persistence.
//
// The walk is synchronous, so "concurrency" is 1 by construction: the caps are
// what bound the work one tick can issue. That is the documented meaning of
// "bounded" for a synchronous API.

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, extname, resolve, sep, matchesGlob } from "node:path";
import { Chunk, SourceKind } from "./models.js";

const DEFAULT_EXTENSIONS = new Set([
  ".py", ".ts", ".tsx", ".js", ".jsx", ".md", ".txt", ".json", ".jsonl", ".csv", ".html", ".css",
]);

/** Files larger than this are not read at all. */
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024; // 1 MiB
/** Total file content one walk may hand to the indexer. */
export const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024; // 32 MiB
/** Files one walk may accept. */
export const DEFAULT_MAX_FILES = 20000;
/** Per-project ignore file, read from the walked root. */
export const DEFAULT_IGNORE_FILE = ".lceignore";

export function chunkText({ content, source, kind, chunkSize = 800, overlap = 80, metadata = {}, timestamp = null, priority = 0 }) {
  if (!content || !content.trim()) return [];
  const text = content.trim();
  const step = Math.max(1, chunkSize - overlap);
  const chunks = [];
  let start = 0;
  let idx = 0;
  while (start < text.length) {
    const piece = text.slice(start, start + chunkSize);
    chunks.push(
      new Chunk({
        id: `${source}:${idx}:${start}`,
        source,
        kind,
        content: piece,
        metadata: { ...metadata },
        timestamp,
        priority,
      }),
    );
    idx += 1;
    if (piece.length < chunkSize) break;
    start += step;
  }
  return chunks;
}

export function ingestText({ content, source, kind, chunkSize = 800, overlap = 80, metadata = {}, timestamp = null, priority = 0 }) {
  return chunkText({ content, source, kind, chunkSize, overlap, metadata, timestamp, priority });
}

export function ingestFile(filePath, kind = null) {
  const text = readFileSync(filePath, "utf8");
  const resolvedKind = kind || kindForPath(filePath);
  const stat = statSync(filePath);
  return chunkText({
    content: text,
    source: filePath,
    kind: resolvedKind,
    metadata: { path: filePath, extension: extname(filePath) },
    timestamp: stat.mtimeMs / 1000,
  });
}

/**
 * Bounded, symlink-safe, ignore-file-aware directory walk. Synchronous.
 *
 * @param {string} directory
 * @param {{
 *   extensions?: Set<string>|string[]|null,
 *   ignore?: string[],
 *   ignoreFile?: string|null,
 *   maxFileBytes?: number,
 *   maxTotalBytes?: number,
 *   maxFiles?: number,
 *   followSymlinks?: boolean,
 * }} [options]
 * @returns {{
 *   files: Array<{path: string, size: number, mtimeMs: number}>,
 *   stats: {sizeSkipped: number, symlinkSkipped: number, ignored: number,
 *           walkErrors: number, truncated: boolean},
 * }}
 */
export function walkFiles(directory, {
  extensions = null,
  ignore = [],
  ignoreFile = DEFAULT_IGNORE_FILE,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
  followSymlinks = false,
} = {}) {
  const root = resolve(String(directory));
  const allowed = new Set(extensions || DEFAULT_EXTENSIONS);
  const builtinIgnore = new Set(ignore || []);
  const ignoreFileMatch = loadIgnoreMatcher(root, ignoreFile);
  const files = [];
  const stats = { sizeSkipped: 0, symlinkSkipped: 0, ignored: 0, walkErrors: 0, truncated: false };
  const visitedRealpaths = new Set();
  let totalBytes = 0;

  const isIgnored = (relPath) => {
    if (builtinIgnore.size > 0 && relPath.split("/").some((part) => builtinIgnore.has(part))) return true;
    return ignoreFileMatch ? ignoreFileMatch(relPath) : false;
  };

  const acceptFile = (fullPath, relPath) => {
    if (isIgnored(relPath)) {
      stats.ignored += 1;
      return;
    }
    if (allowed.size > 0 && !allowed.has(extname(fullPath).toLowerCase())) return;
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      stats.walkErrors += 1;
      return;
    }
    if (!stat.isFile()) return;
    if (stat.size > maxFileBytes) {
      stats.sizeSkipped += 1;
      return;
    }
    if (files.length >= maxFiles || totalBytes + stat.size > maxTotalBytes) {
      stats.truncated = true;
      return;
    }
    totalBytes += stat.size;
    files.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
  };

  const walkDir = (dir) => {
    if (stats.truncated) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      stats.walkErrors += 1;
      return;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (stats.truncated) return;
      const fullPath = join(dir, entry.name);
      const relPath = relative(root, fullPath).split(sep).join("/");

      if (entry.isSymbolicLink()) {
        if (!followSymlinks) {
          stats.symlinkSkipped += 1;
          continue;
        }
        // Opt-in only. A loop is structurally impossible in the default mode;
        // here it is prevented by remembering every resolved real path.
        let realPath;
        let stat;
        try {
          realPath = realpathSync(fullPath);
          stat = statSync(fullPath);
        } catch {
          stats.walkErrors += 1;
          continue;
        }
        if (visitedRealpaths.has(realPath)) {
          stats.symlinkSkipped += 1;
          continue;
        }
        if (stat.isDirectory()) {
          visitedRealpaths.add(realPath);
          walkDir(fullPath);
        } else if (stat.isFile()) {
          acceptFile(fullPath, relPath);
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (isIgnored(relPath)) {
          stats.ignored += 1;
          continue;
        }
        if (followSymlinks) {
          let realPath;
          try {
            realPath = realpathSync(fullPath);
          } catch {
            stats.walkErrors += 1;
            continue;
          }
          if (visitedRealpaths.has(realPath)) continue;
          visitedRealpaths.add(realPath);
        }
        walkDir(fullPath);
        continue;
      }

      if (entry.isFile()) acceptFile(fullPath, relPath);
    }
  };

  walkDir(root);
  return { files, stats };
}

/**
 * Incremental directory ingest: the bounded walk + mtime/size diffing + chunk
 * building. Synchronous; the caller owns state persistence.
 *
 * `state` returned is the **complete** next state — one entry per file this
 * walk actually visited, so pruning deleted files is the walk's job. The caller
 * must persist it verbatim (no merge, no `existsSync` second-guessing).
 *
 * @returns {{
 *   chunks: Chunk[],
 *   state: Record<string, {mtime: number, size: number}>,
 *   stats: {added: number, changed: number, skipped: number, sizeSkipped: number,
 *           symlinkSkipped: number, ignored: number, walkErrors: number,
 *           truncated: boolean},
 * }}
 */
export function ingestDirectoryIncremental({
  directory,
  state = {},
  kind = null,
  extensions = null,
  ignore = [],
  ignoreFile = DEFAULT_IGNORE_FILE,
  maxFileBytes = null,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
} = {}) {
  const effectiveMaxFileBytes = maxFileBytes === null || maxFileBytes === undefined
    ? DEFAULT_MAX_FILE_BYTES
    : maxFileBytes;
  const { files, stats: walkStats } = walkFiles(directory, {
    extensions,
    ignore,
    ignoreFile,
    maxFileBytes: effectiveMaxFileBytes,
    maxTotalBytes,
    maxFiles,
  });
  const previousState = state && typeof state === "object" ? state : {};
  const nextState = {};
  const chunks = [];
  const stats = {
    added: 0,
    changed: 0,
    skipped: 0,
    sizeSkipped: walkStats.sizeSkipped,
    symlinkSkipped: walkStats.symlinkSkipped,
    ignored: walkStats.ignored,
    walkErrors: walkStats.walkErrors,
    truncated: walkStats.truncated,
  };

  for (const file of files) {
    const key = resolve(file.path);
    const previous = previousState[key];
    if (previous && previous.mtime === file.mtimeMs && previous.size === file.size) {
      stats.skipped += 1;
      nextState[key] = { mtime: previous.mtime, size: previous.size };
      continue;
    }
    try {
      const produced = ingestFile(file.path, kind);
      for (const chunk of produced) chunks.push(chunk);
      stats.added += produced.length;
      stats.changed += produced.length > 0 ? 1 : 0;
      nextState[key] = { mtime: file.mtimeMs, size: file.size };
    } catch {
      stats.walkErrors += 1;
    }
  }

  return { chunks, state: nextState, stats };
}

export function ingestDirectory(directory, {
  kind = null,
  extensions = null,
  ignore = [],
  ignoreFile = DEFAULT_IGNORE_FILE,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxFiles = DEFAULT_MAX_FILES,
} = {}) {
  const { files } = walkFiles(directory, { extensions, ignore, ignoreFile, maxFileBytes, maxTotalBytes, maxFiles });
  const chunks = [];
  for (const file of files) {
    try {
      for (const chunk of ingestFile(file.path, kind)) chunks.push(chunk);
    } catch {
      // skip unreadable files
    }
  }
  return chunks;
}

export function ingestHistoryJsonl(filePath, sourceName = null) {
  const source = sourceName || filePath;
  const lines = readFileSync(filePath, "utf8").split("\n");
  const chunks = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx].trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const content = record.content || record.text || record.message;
    if (!content) continue;
    let timestamp = record.timestamp;
    if (typeof timestamp === "string") timestamp = Number(timestamp) || null;
    chunks.push(
      new Chunk({
        id: `${source}:history:${idx}`,
        source,
        kind: SourceKind.HISTORY,
        content: `${record.role || "unknown"}: ${content}`,
        metadata: record,
        timestamp,
        priority: record.important ? 1 : 0,
      }),
    );
  }
  return chunks;
}

export function ingestTrajectoryJsonl(filePath, sourceName = null) {
  const source = sourceName || filePath;
  const lines = readFileSync(filePath, "utf8").split("\n");
  const chunks = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx].trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const tool = record.tool || record.action || "tool";
    const contentParts = [];
    if (record.input) contentParts.push(`input: ${record.input}`);
    if (record.output) contentParts.push(`output: ${record.output}`);
    if (record.thought || record.reasoning) contentParts.push(`reasoning: ${record.thought || record.reasoning}`);
    if (contentParts.length === 0) contentParts.push(JSON.stringify(record));
    let timestamp = record.timestamp;
    if (typeof timestamp === "string") timestamp = Number(timestamp) || null;
    chunks.push(
      new Chunk({
        id: `${source}:trajectory:${idx}`,
        source,
        kind: SourceKind.TRAJECTORY,
        content: `[${tool}] ${contentParts.join(" | ")}`,
        metadata: record,
        timestamp,
        priority: record.important ? 2 : 0,
      }),
    );
  }
  return chunks;
}

export function kindForPath(filePath) {
  const suffix = extname(filePath).toLowerCase();
  if ([".py", ".ts", ".tsx", ".js", ".jsx", ".java", ".go", ".rs", ".c", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt", ".sql"].includes(suffix)) {
    return SourceKind.CODE;
  }
  return SourceKind.FILE;
}

export function relativePath(directory, filePath) {
  return relative(directory, filePath);
}

/**
 * Compile `<root>/.lceignore` into a predicate over a POSIX relative path.
 *
 * Semantics (gitignore-like, deliberately small):
 *   - one pattern per line; blank lines and `#` comments are skipped
 *   - a pattern without `/` matches any path segment (file or directory)
 *   - a pattern with `/` matches the relative path, or that path's subtree
 *   - a trailing `/` restricts the pattern to directories (its subtree)
 *   - invalid/unreadable ignore file -> no patterns (never throws)
 */
function loadIgnoreMatcher(root, ignoreFile) {
  if (!ignoreFile) return null;
  let raw;
  try {
    raw = readFileSync(join(root, String(ignoreFile)), "utf8");
  } catch {
    return null;
  }
  const patterns = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (patterns.length === 0) return null;
  const compiled = patterns.map(compileIgnorePattern).filter(Boolean);
  if (compiled.length === 0) return null;
  return (relPath) => compiled.some((matches) => matches(relPath));
}

function compileIgnorePattern(pattern) {
  const normalized = String(pattern).replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  const directoryOnly = normalized.endsWith("/");
  const body = normalized.replace(/\/+$/, "");
  if (!body) return null;
  return (relPath) => {
    if (!body.includes("/")) {
      // Bare name: any segment on the path (a file name, or a directory).
      return relPath.split("/").some((part) => globMatch(part, body));
    }
    if (globMatch(relPath, body)) return true;
    if (globMatch(relPath, `${body}/**`)) return true;
    // A directory-only pattern also matches the directory itself.
    return directoryOnly && relPath === body;
  };
}

function globMatch(pathValue, pattern) {
  if (typeof matchesGlob === "function") {
    try {
      return matchesGlob(pathValue, pattern);
    } catch {
      // fall through to the conservative matcher below
    }
  }
  if (pathValue === pattern) return true;
  const prefix = pattern.replace(/\/\*\*$/, "");
  return pathValue.startsWith(`${prefix}/`);
}

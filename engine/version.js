// Host compatibility facts for the DSH plugin.
//
// The plugin is built against one DSH release but has to run on a range of
// them, and several behaviours it depends on changed shape between releases.
// Everything version-sensitive lands here so `context_prism_status` can report
// what the host actually gives us instead of what we assumed.

/** The DSH release this plugin is developed and tested against. */
export const TARGET_DSH_VERSION = "0.2.1-rc.5";

/** Oldest DSH release whose plugin API this port still supports. */
export const MIN_DSH_VERSION = "0.2.1-rc.5";

/** Node runtime shipped with TARGET_DSH_VERSION. */
export const TARGET_NODE_VERSION = "24.21.0";

/**
 * Parse a semver-ish version ("0.2.1-rc.5") into comparable parts.
 * @param {string} value - version text, optionally prefixed with "v".
 * @returns {{major: number, minor: number, patch: number, prerelease: string}|null}
 */
export function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || "",
  };
}

/**
 * Compare two versions with prerelease ordering (a prerelease sorts before its
 * release, so 0.2.1-rc.5 < 0.2.1).
 * @returns {number} negative when a < b, 0 when equal, positive when a > b.
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/**
 * Decide whether a host version is inside the supported window.
 * @param {string|null} hostVersion - version reported by the running DSH host.
 * @returns {{supported: boolean|null, reason: string}}
 */
export function checkHostVersion(hostVersion) {
  if (!hostVersion) {
    return { supported: null, reason: "host did not report a version; compatibility unknown" };
  }
  if (compareVersions(hostVersion, MIN_DSH_VERSION) < 0) {
    return { supported: false, reason: `host ${hostVersion} is older than the supported minimum ${MIN_DSH_VERSION}` };
  }
  return { supported: true, reason: `host ${hostVersion} is within the supported range (target ${TARGET_DSH_VERSION})` };
}

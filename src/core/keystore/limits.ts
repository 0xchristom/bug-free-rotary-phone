/**
 * Dependency-free keystore limits and fleet-name rules, shared with src/storage so it
 * does not pull in any cryptography (BUNNDLY-8).
 */

/** Keystore files above this size are rejected before reading or parsing. */
export const MAX_KEYSTORE_FILE_BYTES = 1024 * 1024;

/** Suffix of the file name: `<fleetName>.keystore.json` (SPEC 3.1). */
export const KEYSTORE_FILE_SUFFIX = '.keystore.json';

/**
 * Fleet name: 1–64 letters, digits, spaces, dots, hyphens or underscores; no leading
 * dot or space, no trailing dot or space.
 */
const FLEET_NAME_RE = /^(?![. ])[\p{L}\p{N} ._-]{1,64}(?<![. ])$/u;

/** Windows device names cannot be file names, even with an extension (e.g. CON.json). */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/iu;

/** True if `<name>.keystore.json` is a safe file name on Windows, macOS and Linux. */
export function isValidFleetName(name: string): boolean {
  return FLEET_NAME_RE.test(name) && !WINDOWS_RESERVED_RE.test(name);
}

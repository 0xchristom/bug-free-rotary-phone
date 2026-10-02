/**
 * Dependency-free keystore limits, fleet-name and password-length rules, shared with
 * src/storage and the UI so they do not pull in any cryptography (BUNNDLY-8, BUNNDLY-9).
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

/** Minimum password length in user-perceived characters (SPEC 3.1). */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * User-perceived characters (grapheme clusters) after NFKC. The UI uses this same
 * function, so its 12-character check matches the one in core.
 */
export function passwordLength(password: string): number {
  return Array.from(new Intl.Segmenter().segment(password.normalize('NFKC'))).length;
}

/** Joins class names, skipping the falsy ones. */
export function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ');
}

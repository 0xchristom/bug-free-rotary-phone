/**
 * Word tokens of every string value in `value` (object keys excluded), lower case.
 * Used to check that no mnemonic word leaks into public data. Keys are skipped because
 * field names such as "index", "label" or "address" are themselves BIP39 words.
 */
export function valueWords(value: unknown, skipKeys: readonly string[] = []): Set<string> {
  const words = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const w of v.toLowerCase().split(/[^\p{L}]+/u)) if (w) words.add(w);
    } else if (Array.isArray(v)) {
      for (const item of v) visit(item);
    } else if (typeof v === 'object' && v !== null) {
      for (const [k, item] of Object.entries(v)) if (!skipKeys.includes(k)) visit(item);
    }
  };
  visit(value);
  return words;
}

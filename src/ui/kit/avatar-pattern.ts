export interface AvatarPattern {
  /** 0–359; the colours come from tokens.css (`--ava-hue`). */
  readonly hue: number;
  /** Filled cells of the 5×5 grid as [x, y], mirrored left to right. */
  readonly cells: readonly (readonly [number, number])[];
}

/** Deterministic 5×5 identicon of an address (or any name): same text, same picture. */
export function avatarPattern(text: string): AvatarPattern {
  let hash = 0;
  for (const char of text) hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) >>> 0;
  const cells: [number, number][] = [];
  let bits = hash;
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      bits = (Math.imul(bits, 1103515245) + 12345) >>> 0;
      if (((bits >>> 16) & 1) === 0) continue;
      cells.push([x, y]);
      if (x < 2) cells.push([4 - x, y]);
    }
  }
  return { hue: hash % 360, cells };
}

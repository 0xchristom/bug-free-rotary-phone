import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The design tokens are data, so they are tested as data: the contrast of every text colour
 * on every surface it sits on is computed from the values in tokens.css with the WCAG 2.x
 * formula written out here (not shared with any application code).
 */
const TOKENS_FILE = 'src/ui/tokens.css';
const AA_TEXT = 4.5;

function readTokens(): Map<string, string> {
  const css = readFileSync(TOKENS_FILE, 'utf8');
  const root = /:root\s*\{([^}]*)\}/u.exec(css)?.[1];
  if (root === undefined) throw new Error('tokens.css has no :root block');
  const tokens = new Map<string, string>();
  for (const [, name, value] of root.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gu)) {
    if (name !== undefined && value !== undefined) tokens.set(name, value.trim());
  }
  return tokens;
}

/** Follows `var(--x)` until a literal value. */
function resolve(tokens: ReadonlyMap<string, string>, name: string): string {
  let value = tokens.get(name);
  for (let hops = 0; hops < 8 && value !== undefined; hops++) {
    const ref = /^var\((--[a-z0-9-]+)\)$/u.exec(value)?.[1];
    if (ref === undefined) return value;
    value = tokens.get(ref);
  }
  throw new Error(`token ${name} does not resolve to a value`);
}

/** WCAG 2.x relative luminance of an opaque `#rrggbb` colour. */
function luminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex);
  if (!match) throw new Error(`not an opaque #rrggbb colour: ${hex}`);
  const [r, g, b] = [match[1], match[2], match[3]].map((pair) => {
    const channel = parseInt(pair ?? '', 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** WCAG 2.x contrast ratio, 1 to 21. */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

const tokens = readTokens();
const surfaces = [...tokens.keys()].filter((name) => name.startsWith('--surface-'));
/** Every `--x-bg` is the surface of the text colour `--x`. */
const tonePairs = [...tokens.keys()]
  .filter((name) => name.endsWith('-bg'))
  .map((bg) => [bg.slice(0, -'-bg'.length), bg] as const);

describe('the contrast formula itself', () => {
  // Reference values from the WCAG definition and the well-known #767676 boundary on white.
  it('gives 21 for black on white and 1 for a colour on itself', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 10);
    expect(contrast('#4bdc8c', '#4bdc8c')).toBe(1);
  });

  it('puts #767676 on white just above 4.5 and #777777 just below', () => {
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });
});

describe('design tokens', () => {
  it('has the surfaces and the tone pairs the kit uses', () => {
    expect(surfaces).toEqual([
      '--surface-page',
      '--surface-base',
      '--surface-row',
      '--surface-panel',
      '--surface-raised',
      '--surface-hover',
    ]);
    expect(tonePairs.map(([text]) => text)).toEqual([
      '--ok',
      '--danger',
      '--warn',
      '--watch',
      '--sim',
      '--muted',
      '--run',
      '--primary',
    ]);
  });

  it.each(surfaces.flatMap((surface) => ['--fg', '--fg-2'].map((text) => [text, surface])))(
    '%s on %s has at least 4.5:1',
    (text, surface) => {
      expect(contrast(resolve(tokens, text), resolve(tokens, surface))).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
    },
  );

  // Captions: --fg-3 is allowed only on the darker surfaces (see tokens.css).
  it.each(['--surface-page', '--surface-base', '--surface-row', '--surface-panel'])(
    '--fg-3 on %s has at least 4.5:1',
    (surface) => {
      expect(contrast(resolve(tokens, '--fg-3'), resolve(tokens, surface))).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
    },
  );

  it.each(tonePairs)('%s on %s has at least 4.5:1', (text, surface) => {
    expect(contrast(resolve(tokens, text), resolve(tokens, surface))).toBeGreaterThanOrEqual(
      AA_TEXT,
    );
  });

  it('the focus ring stands out from every surface (3:1, WCAG 1.4.11)', () => {
    for (const surface of surfaces) {
      expect(contrast(resolve(tokens, '--focus'), resolve(tokens, surface))).toBeGreaterThanOrEqual(
        3,
      );
    }
  });
});

describe('colour literals', () => {
  // The same pattern as the acceptance check of BUNNDLY-54.
  const LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/u;

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(?:css|ts|tsx)$/u.test(entry.name) ? [path] : [];
    });
  }

  it('the component kit and the font sheet hold none: colours live in tokens.css', () => {
    const files = [...sourceFiles('src/ui/kit'), 'src/ui/fonts.css'];
    expect(files.length).toBeGreaterThan(10);
    const hits = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          LITERAL.test(line) ? [`${file}:${String(index + 1)}: ${line.trim()}`] : [],
        ),
    );
    expect(hits).toEqual([]);
  });
});

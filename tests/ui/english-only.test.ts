/**
 * The interface is English only, with no language choice (BUNNDLY-50, SPEC 5). Polish
 * letters in the code of `src` (comments aside) mean a Polish string was left behind or
 * came back.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const POLISH = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/u;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|css)$/u.test(entry.name) ? [path] : [];
  });
}

/**
 * Block and line comments blanked out, line numbers kept. A `//` counts as a comment at
 * the start of a line or after whitespace, so `https://…` inside a string stays.
 */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, ' '))
    .replace(/(^|\s)\/\/[^\n]*/gmu, '$1');
}

function polishLines(text: string): string[] {
  return withoutComments(text)
    .split('\n')
    .flatMap((line, i) => (POLISH.test(line) ? [`${String(i + 1)}: ${line.trim()}`] : []));
}

describe('English-only interface', () => {
  it('the scan itself sees a Polish string and skips a Polish comment', () => {
    expect(polishLines("const a = 'Zapisz flotę';\n// komentarz z ogonkiem: ż\n")).toEqual([
      "1: const a = 'Zapisz flotę';",
    ]);
    expect(polishLines('/* wieloliniowy\n   ąę */\nconst b = <p>Hasło</p>;\n')).toEqual([
      '3: const b = <p>Hasło</p>;',
    ]);
    expect(polishLines("const url = 'https://example.test/ścieżka';\n")).toHaveLength(1);
  });

  it('src has no Polish letters outside comments', () => {
    const files = sourceFiles(join(ROOT, 'src'));
    // The scan would pass on an empty folder: the app has far more files than this.
    expect(files.length).toBeGreaterThan(50);
    const found = files.flatMap((file) =>
      polishLines(readFileSync(file, 'utf8')).map(
        (line) => `${relative(ROOT, file).replaceAll('\\', '/')}:${line}`,
      ),
    );
    expect(found).toEqual([]);
  });

  it('the page declares English and offers no language setting', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    expect(html).toMatch(/<html lang="en">/u);
    expect(POLISH.test(html)).toBe(false);
    const code = sourceFiles(join(ROOT, 'src'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(code).not.toMatch(/\bi18n\b|\blocale\s*[:=]|\blanguage\s*[:=]|pl-PL/u);
  });
});

/**
 * `public/_headers` (Cloudflare Pages format) as the single source of the security
 * headers (SPEC 6.4, D-025). Cloudflare applies the file itself; this module parses it so
 * that `vite preview` sends exactly the same headers, and the tests check its content.
 *
 * Supported subset of the format: comment lines (`#`), a URL pattern line, then indented
 * `Name: value` lines. Patterns are exact paths or a path ending in a single `*` splat.
 * https://developers.cloudflare.com/pages/configuration/headers/
 */
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

export interface HeaderRule {
  readonly pattern: string;
  readonly headers: readonly (readonly [name: string, value: string])[];
}

export function parseHeadersFile(text: string): HeaderRule[] {
  const rules: { pattern: string; headers: [string, string][] }[] = [];
  for (const [i, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trimEnd();
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/u.test(line)) {
      rules.push({ pattern: line.trim(), headers: [] });
      continue;
    }
    const rule = rules.at(-1);
    const colon = line.indexOf(':');
    if (rule === undefined || colon < 0) {
      throw new Error(`_headers line ${String(i + 1)}: expected "Name: value" under a URL pattern`);
    }
    rule.headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return rules;
}

export function matches(pattern: string, path: string): boolean {
  return pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern;
}

/** Headers for a request path; a header set by several rules is joined with ", ". */
export function headersFor(rules: readonly HeaderRule[], path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rule of rules) {
    if (!matches(rule.pattern, path)) continue;
    for (const [name, value] of rule.headers) {
      const key = name.toLowerCase();
      const previous = out.get(key);
      out.set(key, previous === undefined ? value : `${previous}, ${value}`);
    }
  }
  return out;
}

/** `vite preview` with the production headers from `public/_headers`. */
export function previewHeaders(file: string): Plugin {
  return {
    name: 'bunndly-preview-headers',
    configurePreviewServer(server) {
      const rules = parseHeadersFile(readFileSync(file, 'utf8'));
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
        for (const [name, value] of headersFor(rules, path)) res.setHeader(name, value);
        next();
      });
    },
  };
}

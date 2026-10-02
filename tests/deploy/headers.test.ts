/**
 * Security headers (SPEC 6.4, BUNNDLY-31): public/_headers is copied verbatim to
 * dist/_headers by `vite build` and served by Cloudflare Pages and `vite preview`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  headersFor,
  parseHeadersFile,
  previewHeaders,
  type HeaderRule,
} from '../../deploy/headers.ts';
import viteConfig from '../../vite.config.ts';

const FILE = 'public/_headers';
const rules = parseHeadersFile(readFileSync(FILE, 'utf8'));
const all = headersFor(rules, '/');

function csp(): Map<string, string[]> {
  const value = all.get('content-security-policy') ?? '';
  return new Map(
    value
      .split(';')
      .map((d) => d.trim().split(/\s+/u))
      .filter((parts) => parts[0] !== '')
      .map(([name = '', ...sources]) => [name, sources]),
  );
}

describe('public/_headers', () => {
  it('one rule for every path, applied to the page, assets and the worker', () => {
    expect(rules.map((r) => r.pattern)).toEqual(['/*']);
    for (const path of ['/', '/index.html', '/assets/index-abc.js', '/assets/vault.worker-x.js']) {
      expect([...headersFor(rules, path).keys()]).toEqual([...all.keys()]);
    }
  });

  it('has exactly the required CSP, without unsafe-eval or unsafe-inline', () => {
    expect(Object.fromEntries(csp())).toEqual({
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'connect-src': [
        "'self'",
        'https://*.helius-rpc.com',
        'wss://*.helius-rpc.com',
        'https://api.jup.ag',
        'https://api.mainnet.solana.com',
      ],
      'worker-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
      'frame-ancestors': ["'none'"],
    });
    const text = all.get('content-security-policy') ?? '';
    expect(text).not.toMatch(/unsafe-eval|unsafe-inline|unsafe-hashes|\*\s|https:\s|http:/u);
  });

  it('frame, referrer, sniffing and permissions headers', () => {
    expect(all.get('x-frame-options')).toBe('DENY');
    expect(all.get('referrer-policy')).toBe('no-referrer');
    expect(all.get('x-content-type-options')).toBe('nosniff');
    const permissions = new Map(
      (all.get('permissions-policy') ?? '').split(',').map((p) => {
        const [name = '', allow = ''] = p.trim().split('=');
        return [name, allow];
      }),
    );
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
      expect(permissions.get(feature)).toBe('()');
    }
    // the watcher keeps the screen on (sprint 4)
    expect(permissions.get('screen-wake-lock')).toBe('(self)');
  });

  it('is copied by vite build to dist/_headers; no 404.html, so Pages serves the SPA', () => {
    expect(viteConfig.publicDir ?? 'public').toBe('public');
    expect(existsSync('public/404.html')).toBe(false);
    // After `npm run build` the copy must be byte for byte the same.
    if (existsSync('dist/_headers')) {
      expect(readFileSync('dist/_headers', 'utf8')).toBe(readFileSync(FILE, 'utf8'));
    }
  });
});

describe('_headers parser and vite preview', () => {
  const sample: HeaderRule[] = parseHeadersFile(
    '# comment\n/*\n  X-A: 1\n/assets/*\n  X-A: 2\n  X-B: b\n/exact\n  X-C: c\n',
  );

  it('matches splats and exact paths, joins repeated headers like Cloudflare', () => {
    expect(Object.fromEntries(headersFor(sample, '/assets/x.js'))).toEqual({
      'x-a': '1, 2',
      'x-b': 'b',
    });
    expect(Object.fromEntries(headersFor(sample, '/exact'))).toEqual({ 'x-a': '1', 'x-c': 'c' });
    expect(Object.fromEntries(headersFor(sample, '/exact/no'))).toEqual({ 'x-a': '1' });
  });

  it('a header line outside a rule is an error', () => {
    expect(() => parseHeadersFile('  X-A: 1\n')).toThrow(/line 1/u);
  });

  it('the preview plugin sets every header from the file on each response', () => {
    const plugin = previewHeaders(FILE);
    let middleware: ((req: { url?: string }, res: object, next: () => void) => void) | undefined;
    const server = {
      middlewares: {
        use: (fn: typeof middleware) => {
          middleware = fn;
        },
      },
    };
    const hook = plugin.configurePreviewServer as (s: typeof server) => void;
    hook(server);
    const set = new Map<string, string>();
    let nextCalled = false;
    middleware?.(
      { url: '/assets/app.js?v=1' },
      {
        setHeader: (name: string, value: string) => {
          set.set(name, value);
        },
      },
      () => {
        nextCalled = true;
      },
    );
    expect(nextCalled).toBe(true);
    expect(set).toEqual(all);
  });
});

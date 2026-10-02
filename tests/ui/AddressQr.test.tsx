// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import decodeQR from 'qr/decode.js';
import { afterEach, describe, expect, it } from 'vitest';
import { AddressQr } from '../../src/ui/AddressQr.tsx';

const ADDRESS = '3ij4bSQqPvWcVM8QKViys7NNC5hA44AAyGxXQSDp3e3P';
const SCALE = 4;

afterEach(cleanup);

/** Rasterizes the rendered SVG (white background + 1×1 module squares) to RGBA. */
function rasterize(svg: SVGSVGElement): { width: number; height: number; data: Uint8Array } {
  const dimension = Number(svg.getAttribute('viewBox')?.split(' ')[2]);
  const size = dimension * SCALE;
  const data = new Uint8Array(size * size * 4).fill(255);
  const d = svg.querySelector('path')?.getAttribute('d') ?? '';
  for (const [, xs, ys] of d.matchAll(/M(\d+) (\d+)h1v1h-1z/gu)) {
    const x0 = Number(xs) * SCALE;
    const y0 = Number(ys) * SCALE;
    for (let y = y0; y < y0 + SCALE; y++) {
      for (let x = x0; x < x0 + SCALE; x++) {
        const i = (y * size + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 0;
      }
    }
  }
  return { width: size, height: size, data };
}

describe('AddressQr', () => {
  it('draws a QR code that decodes back to the address, with a quiet zone', () => {
    render(<AddressQr address={ADDRESS} />);
    const svg = screen.getByRole('img', { name: `Kod QR adresu ${ADDRESS}` });
    if (!(svg instanceof SVGSVGElement)) throw new Error('expected an <svg>');
    expect(decodeQR(rasterize(svg))).toBe(ADDRESS);
    // the first 4 rows/columns stay white
    expect(svg.querySelector('path')?.getAttribute('d')).not.toMatch(/M[0-3] |M\d+ [0-3]h/u);
  });

  it('uses no injected HTML (works under a strict CSP)', () => {
    const { container } = render(<AddressQr address={ADDRESS} />);
    expect(container.querySelector('foreignObject, script, image')).toBeNull();
  });
});

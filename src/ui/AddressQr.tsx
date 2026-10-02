import encodeQR from 'qr';
import { useMemo } from 'react';

export interface AddressQrProps {
  readonly address: string;
  /** Rendered size in CSS pixels. */
  readonly size?: number;
}

/** Quiet zone around the code, in modules (the QR standard asks for 4). */
const QUIET_ZONE = 4;

/**
 * QR code of a deposit address, drawn as SVG rects from the raw module matrix. No HTML
 * string is injected into the page, so this works under a strict CSP.
 */
export function AddressQr({ address, size = 192 }: AddressQrProps) {
  const { path, dimension } = useMemo(() => {
    const modules = encodeQR(address, 'raw', { ecc: 'medium', border: QUIET_ZONE });
    const parts: string[] = [];
    modules.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) parts.push(`M${String(x)} ${String(y)}h1v1h-1z`);
      });
    });
    return { path: parts.join(''), dimension: modules.length };
  }, [address]);

  return (
    <svg
      className="qr"
      role="img"
      aria-label={`Kod QR adresu ${address}`}
      width={size}
      height={size}
      viewBox={`0 0 ${String(dimension)} ${String(dimension)}`}
      shapeRendering="crispEdges"
    >
      <rect width={dimension} height={dimension} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

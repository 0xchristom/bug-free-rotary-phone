/**
 * Plain export of the mnemonic and private keys (SPEC 3.1), built only after the vault
 * re-checked the password (exportPlain, D-023). The private keys are base58 of the 64-byte
 * secret key (seed + public key), the format Phantom and Solflare import.
 */
import type { KeystoreFileV1, KeystoreSecretsV1 } from './format.ts';

export type PlainExportFormat = 'txt' | 'json';

export interface PlainExport {
  readonly fileName: string;
  readonly mimeType: string;
  readonly text: string;
}

export const PLAIN_EXPORT_WARNING =
  'UWAGA: ten plik zawiera mnemonik i klucze prywatne w czystym tekście. Każdy, kto go zobaczy, może zabrać wszystkie środki z floty. Przechowuj go offline i nikomu nie wysyłaj.';

interface ExportWallet {
  readonly index: number;
  readonly label: string;
  readonly derivationPath: string;
  readonly address: string;
  readonly secretKey: string;
}

function walletsOf(file: KeystoreFileV1, secrets: KeystoreSecretsV1): ExportWallet[] {
  const keys = new Map(secrets.wallets.map((w) => [w.index, w.secretKey]));
  return file.public.wallets.map((w) => ({
    index: w.index,
    label: w.label,
    derivationPath: w.derivationPath,
    address: w.address,
    secretKey: keys.get(w.index) ?? '',
  }));
}

/**
 * Builds the export from a keystore that was just decrypted with the password, so the
 * public part has been checked against the keys (openKeystore).
 */
export function buildPlainExport(
  file: KeystoreFileV1,
  secrets: KeystoreSecretsV1,
  format: PlainExportFormat,
  exportedAt: Date,
): PlainExport {
  const wallets = walletsOf(file, secrets);
  const base = `${file.fleetName}.EKSPORT-JAWNY`;
  if (format === 'json') {
    const json = {
      warning: PLAIN_EXPORT_WARNING,
      fleetName: file.fleetName,
      exportedAt: exportedAt.toISOString(),
      mnemonic: secrets.mnemonic,
      wallets,
    };
    return {
      fileName: `${base}.json`,
      mimeType: 'application/json',
      text: `${JSON.stringify(json, null, 2)}\n`,
    };
  }
  const lines = [
    PLAIN_EXPORT_WARNING,
    '',
    `Flota: ${file.fleetName}`,
    `Data eksportu: ${exportedAt.toISOString()}`,
    '',
    `Mnemonik (BIP39, ${String(secrets.mnemonic.split(' ').length)} słów):`,
    secrets.mnemonic,
    '',
    'Portfele (klucz prywatny: base58, 64 bajty, import w Phantom / Solflare):',
    ...wallets.flatMap((w) => [
      '',
      `${w.label} (indeks ${String(w.index)}, ścieżka ${w.derivationPath})`,
      `  Adres: ${w.address}`,
      `  Klucz prywatny: ${w.secretKey}`,
    ]),
    '',
  ];
  return { fileName: `${base}.txt`, mimeType: 'text/plain', text: lines.join('\n') };
}

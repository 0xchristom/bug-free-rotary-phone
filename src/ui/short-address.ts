/** First 4 and last 4 characters of an address: enough to tell wallets apart in a row. */
export function shortAddress(address: string): string {
  return address.length <= 9 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

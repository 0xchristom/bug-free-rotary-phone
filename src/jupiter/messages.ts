/**
 * English messages for Jupiter results (SPEC 5): failures of a call, reasons why `/order`
 * built no transaction and `/execute` outcomes. Fixed texts only; never Jupiter's own
 * free-text message, which may be parameterised (order-and-execute.md).
 */
import type { ExecuteOutcome, JupiterFailureCode, OrderBuildReason } from './client.ts';

const FAILURES: Record<JupiterFailureCode, string> = {
  RATE_LIMITED:
    'Jupiter: rate limit exceeded (HTTP 429). The request will wait for a free slot in the limit window.',
  SERVER_ERROR: 'Jupiter: service error (HTTP 5xx).',
  TIMEOUT: 'Jupiter did not respond in time.',
  NETWORK: 'Could not connect to Jupiter (network, CORS or CSP).',
  NO_ROUTE:
    'Jupiter found no route for this token and amount. A fresh token may have no liquidity yet.',
  BAD_REQUEST: 'Jupiter rejected the request as invalid (e.g. a wrong mint address or amount).',
  UNAUTHORIZED: 'Jupiter rejected the API key (HTTP 401). Check the key in Settings.',
  FORBIDDEN:
    'Jupiter: access forbidden (HTTP 403). The key has no access to the Swap API or a firewall blocks it.',
  HTTP_ERROR: 'Jupiter responded with an unexpected HTTP code.',
  INVALID_RESPONSE: 'Jupiter returned a response in an unexpected format.',
};

const BUILD_REASONS: Record<OrderBuildReason, string> = {
  INSUFFICIENT_FUNDS: 'Not enough funds in the wallet for this buy.',
  INSUFFICIENT_SOL_FOR_GAS: 'Not enough SOL for the transaction fee.',
  BELOW_GASLESS_MINIMUM: 'The amount is below the minimum for a gasless transaction.',
  MISSING_TOKEN_ACCOUNT: 'The token account (ATA) required by the market maker is missing.',
  QUOTE_NOT_BUILDABLE: 'The market maker gave a price, but the transaction could not be built.',
  OTHER: 'Jupiter gave a price but built no transaction.',
};

const EXECUTE_OUTCOMES: Record<ExecuteOutcome, string> = {
  SUCCESS: 'Transaction confirmed.',
  ORDER_NOT_FOUND: 'The order expired or does not exist (requestId).',
  INVALID_SIGNED_TRANSACTION: 'Jupiter rejected the signed transaction.',
  INVALID_MESSAGE_BYTES: 'Jupiter rejected the transaction message.',
  AGGREGATOR_FAILED_TO_LAND: 'The transaction did not land in a block.',
  AGGREGATOR_UNKNOWN: 'Unknown transaction execution error.',
  AGGREGATOR_INVALID_TRANSACTION: 'Invalid transaction.',
  AGGREGATOR_NOT_FULLY_SIGNED: 'The transaction is not fully signed.',
  AGGREGATOR_INVALID_BLOCK_HEIGHT: 'The transaction expired (blockhash).',
  RFQ_FAILED_TO_LAND: 'The RFQ transaction did not land in a block.',
  RFQ_UNKNOWN: 'Unknown RFQ transaction execution error.',
  RFQ_INVALID_PAYLOAD: 'Jupiter rejected the RFQ transaction payload.',
  RFQ_QUOTE_EXPIRED: "The market maker's quote expired.",
  RFQ_SWAP_REJECTED: 'The market maker rejected the transaction.',
  UNDOCUMENTED: 'Jupiter returned a result code that is not in its documentation.',
};

export const JUPITER_MESSAGES = {
  failure: (code: JupiterFailureCode): string => FAILURES[code],
  buildReason: (reason: OrderBuildReason): string => BUILD_REASONS[reason],
  executeOutcome: (outcome: ExecuteOutcome): string => EXECUTE_OUTCOMES[outcome],
} as const;

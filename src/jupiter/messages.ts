/**
 * Polish messages for Jupiter results (SPEC 5): failures of a call, reasons why `/order`
 * built no transaction and `/execute` outcomes. Fixed texts only; never Jupiter's own
 * free-text message, which may be parameterised (order-and-execute.md).
 */
import type { ExecuteOutcome, JupiterFailureCode, OrderBuildReason } from './client.ts';

const FAILURES: Record<JupiterFailureCode, string> = {
  RATE_LIMITED:
    'Jupiter: przekroczony limit zapytań (HTTP 429). Zapytanie poczeka na wolne miejsce w oknie limitu.',
  SERVER_ERROR: 'Jupiter: błąd po stronie usługi (HTTP 5xx).',
  TIMEOUT: 'Jupiter nie odpowiedział w wyznaczonym czasie.',
  NETWORK: 'Nie udało się połączyć z Jupiterem (sieć, CORS albo CSP).',
  NO_ROUTE:
    'Jupiter nie znalazł trasy dla tego tokenu i kwoty. Świeży token może jeszcze nie mieć płynności.',
  BAD_REQUEST: 'Jupiter odrzucił zapytanie jako nieprawidłowe (np. zły adres mintu albo kwota).',
  UNAUTHORIZED: 'Jupiter odrzucił klucz API (HTTP 401). Sprawdź klucz w ustawieniach.',
  FORBIDDEN:
    'Jupiter: dostęp zabroniony (HTTP 403). Klucz nie ma dostępu do Swap API albo blokuje go firewall.',
  HTTP_ERROR: 'Jupiter odpowiedział nieoczekiwanym kodem HTTP.',
  INVALID_RESPONSE: 'Jupiter zwrócił odpowiedź w nieoczekiwanym formacie.',
};

const BUILD_REASONS: Record<OrderBuildReason, string> = {
  INSUFFICIENT_FUNDS: 'Za mało środków w portfelu na ten zakup.',
  INSUFFICIENT_SOL_FOR_GAS: 'Za mało SOL na opłatę transakcyjną.',
  BELOW_GASLESS_MINIMUM: 'Kwota poniżej minimum dla transakcji bez opłaty (gasless).',
  MISSING_TOKEN_ACCOUNT: 'Brak konta tokenu (ATA) wymaganego przez market makera.',
  QUOTE_NOT_BUILDABLE: 'Market maker podał cenę, ale nie dało się zbudować transakcji.',
  OTHER: 'Jupiter podał cenę, ale nie zbudował transakcji.',
};

const EXECUTE_OUTCOMES: Record<ExecuteOutcome, string> = {
  SUCCESS: 'Transakcja potwierdzona.',
  ORDER_NOT_FOUND: 'Zlecenie wygasło albo nie istnieje (requestId).',
  INVALID_SIGNED_TRANSACTION: 'Jupiter odrzucił podpisaną transakcję.',
  INVALID_MESSAGE_BYTES: 'Jupiter odrzucił treść transakcji.',
  AGGREGATOR_FAILED_TO_LAND: 'Transakcja nie trafiła do bloku.',
  AGGREGATOR_UNKNOWN: 'Nieznany błąd wykonania transakcji.',
  AGGREGATOR_INVALID_TRANSACTION: 'Nieprawidłowa transakcja.',
  AGGREGATOR_NOT_FULLY_SIGNED: 'Transakcja nie ma wszystkich podpisów.',
  AGGREGATOR_INVALID_BLOCK_HEIGHT: 'Transakcja wygasła (blockhash).',
  RFQ_FAILED_TO_LAND: 'Transakcja RFQ nie trafiła do bloku.',
  RFQ_UNKNOWN: 'Nieznany błąd wykonania transakcji RFQ.',
  RFQ_INVALID_PAYLOAD: 'Jupiter odrzucił dane transakcji RFQ.',
  RFQ_QUOTE_EXPIRED: 'Oferta market makera wygasła.',
  RFQ_SWAP_REJECTED: 'Market maker odrzucił transakcję.',
  UNDOCUMENTED: 'Jupiter zwrócił nieopisany w dokumentacji kod wyniku.',
};

export const JUPITER_MESSAGES = {
  failure: (code: JupiterFailureCode): string => FAILURES[code],
  buildReason: (reason: OrderBuildReason): string => BUILD_REASONS[reason],
  executeOutcome: (outcome: ExecuteOutcome): string => EXECUTE_OUTCOMES[outcome],
} as const;

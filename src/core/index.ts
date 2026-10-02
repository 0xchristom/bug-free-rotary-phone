// Pure TS, no DOM: derivation, keystore crypto, types, state machine, limiter (SPEC 4).
export {
  AppError,
  ERROR_MESSAGES,
  UNKNOWN_ERROR_MESSAGE,
  isAppError,
  toUserMessage,
} from './errors.ts';
export type { AppErrorOptions, ErrorCode } from './errors.ts';

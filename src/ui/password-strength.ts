/**
 * Simple password strength heuristic for the fleet wizard (BUNNDLY-9). No dependencies.
 * Length is counted exactly like core (passwordLength), so "too short" here means the
 * same as PASSWORD_TOO_SHORT in the keystore.
 */
import { MIN_PASSWORD_LENGTH, passwordLength } from '../core/keystore/limits.ts';

export type StrengthScore = 0 | 1 | 2 | 3 | 4;

export interface PasswordStrength {
  readonly score: StrengthScore;
  readonly label: string;
  /** Characters counted like core (graphemes after NFKC). */
  readonly length: number;
  /** False below MIN_PASSWORD_LENGTH: the wizard blocks the create button. */
  readonly acceptable: boolean;
  readonly hints: readonly string[];
}

const LABELS: Record<StrengthScore, string> = {
  0: 'Za krótkie',
  1: 'Słabe',
  2: 'Średnie',
  3: 'Dobre',
  4: 'Bardzo dobre',
};

/** Frequent passwords and words (lower case, digits and symbols stripped before matching). */
const COMMON = [
  'password',
  'passwort',
  'haslo',
  'qwerty',
  'qwertyuiop',
  'azerty',
  'letmein',
  'welcome',
  'iloveyou',
  'kochamcie',
  'admin',
  'administrator',
  'monkey',
  'dragon',
  'football',
  'baseball',
  'master',
  'sunshine',
  'princess',
  'solana',
  'bitcoin',
  'ethereum',
  'crypto',
  'wallet',
  'phantom',
  'polska',
  'zaqxsw',
  'abc',
  'test',
] as const;

const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'qwertzuiop', 'yxcvbnm'];

function characterClasses(pw: string): number {
  const classes = [/\p{Ll}/u, /\p{Lu}/u, /\p{Nd}/u, /[^\p{L}\p{Nd}\s]/u, /\s/u];
  return classes.filter((re) => re.test(pw)).length;
}

/** Runs of 4+ code points going up or down by one (abcd, 4321). */
function hasSequence(pw: string): boolean {
  const cps = Array.from(pw.toLowerCase(), (c) => c.codePointAt(0) ?? 0);
  let up = 1;
  let down = 1;
  for (let i = 1; i < cps.length; i++) {
    const d = (cps[i] ?? 0) - (cps[i - 1] ?? 0);
    up = d === 1 ? up + 1 : 1;
    down = d === -1 ? down + 1 : 1;
    if (up >= 4 || down >= 4) return true;
  }
  return false;
}

function hasKeyboardRun(pw: string): boolean {
  const lower = pw.toLowerCase();
  return KEYBOARD_ROWS.some((row) => {
    for (let i = 0; i + 4 <= row.length; i++) {
      const chunk = row.slice(i, i + 4);
      if (lower.includes(chunk) || lower.includes(Array.from(chunk).reverse().join('')))
        return true;
    }
    return false;
  });
}

function hasRepeats(pw: string, length: number): boolean {
  const unique = new Set(Array.from(pw.toLowerCase())).size;
  return /(.)\1\1/u.test(pw) || unique < length / 2;
}

function containsCommon(pw: string): boolean {
  const letters = pw
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  return COMMON.some((word) => word.length >= 4 && letters.includes(word)) || letters.length === 0;
}

export function passwordStrength(password: string): PasswordStrength {
  const length = passwordLength(password);
  if (length < MIN_PASSWORD_LENGTH) {
    return {
      score: 0,
      label: LABELS[0],
      length,
      acceptable: false,
      hints: [`Użyj co najmniej ${String(MIN_PASSWORD_LENGTH)} znaków (teraz: ${String(length)}).`],
    };
  }
  const hints: string[] = [];
  let score = length >= 20 ? 3 : length >= 16 ? 2 : 1;
  const classes = characterClasses(password);
  if (classes >= 3) score += 1;
  if (classes >= 4 || length >= 24) score += 1;
  if (classes < 3) hints.push('Połącz małe i wielkie litery, cyfry oraz znaki specjalne.');

  if (hasRepeats(password, length)) {
    score -= 1;
    hints.push('Unikaj powtórzeń tych samych znaków.');
  }
  if (hasSequence(password) || hasKeyboardRun(password)) {
    score -= 1;
    hints.push('Unikaj sekwencji (abcd, 1234) i układów klawiatury (qwerty).');
  }
  if (containsCommon(password)) {
    score = Math.min(score, 1);
    hints.push('Hasło zawiera popularne słowo lub wzorzec. Użyj frazy z kilku przypadkowych słów.');
  }
  const clamped = Math.max(1, Math.min(4, score)) as StrengthScore;
  return { score: clamped, label: LABELS[clamped], length, acceptable: true, hints };
}

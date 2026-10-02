import { describe, expect, it } from 'vitest';
import { MIN_PASSWORD_LENGTH, passwordLength } from '../../src/core/index.ts';
import { passwordStrength } from '../../src/ui/password-strength.ts';

describe('passwordStrength', () => {
  it('counts length exactly like core and blocks below 12 characters', () => {
    for (const pw of ['', 'short', '12345678901', 'ą'.normalize('NFD').repeat(11)]) {
      const s = passwordStrength(pw);
      expect(s.length).toBe(passwordLength(pw));
      expect(s.acceptable).toBe(false);
      expect(s.score).toBe(0);
      expect(s.label).toBe('Za krótkie');
      expect(s.hints[0]).toContain(`${String(MIN_PASSWORD_LENGTH)} znaków`);
    }
    // 12 graphemes: "ą" in NFD is two code points but one character, as in core
    const nfd = 'ą'.normalize('NFD').repeat(6) + 'Kx7#Pm';
    expect(passwordLength(nfd)).toBe(12);
    expect(passwordStrength(nfd).acceptable).toBe(true);
  });

  it.each([
    ['password1234', 1],
    ['Haslo123!Haslo', 1],
    ['qwertyuiop12', 1],
    ['aaaaaaaaaaaa', 1],
    ['abcdefghijkl', 1],
    ['123456789012', 1],
    ['solana-wallet-2026', 1],
  ])('%j is weak (score %i)', (pw, max) => {
    const s = passwordStrength(pw);
    expect(s.acceptable).toBe(true);
    expect(s.score).toBeLessThanOrEqual(max);
    expect(s.hints.length).toBeGreaterThan(0);
  });

  it.each([
    ['Tk9#mQ2!vR8&', 3],
    ['zielony Kot, 7 krzeseł; drabina', 4],
    ['Wż3ś!pLq#9rT@kV', 3],
    ['Wż3ś!pLq#9rT@kV2#xQ', 4],
  ])('%j is at least score %i', (pw, min) => {
    expect(passwordStrength(pw).score).toBeGreaterThanOrEqual(min);
  });

  it('longer is not weaker for the same style', () => {
    expect(passwordStrength('Gx7!kPq2Rz9#mW4$').score).toBeGreaterThanOrEqual(
      passwordStrength('Gx7!kPq2Rz9#').score,
    );
  });

  it('labels are Polish and score stays within 0..4', () => {
    const labels = new Set<string>();
    for (const pw of ['x', 'password1234', 'Tk9#mQ2!vR8&', 'zielony Kot, 7 krzeseł; drabina']) {
      const s = passwordStrength(pw);
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(4);
      labels.add(s.label);
    }
    expect([...labels].every((l) => /^[\p{L} ]+$/u.test(l))).toBe(true);
  });
});

// @vitest-environment jsdom
/** The Settings form and VaultInfo in the UI. Setup: SettingsScreen.fixture.tsx. */
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { VaultFileResult } from '../../src/worker/protocol.ts';
import { enter } from './user.ts';
import {
  HELIUS_KEY,
  setup,
  field,
  retype,
  saveButton,
  saveSettings,
} from './SettingsScreen.fixture.tsx';

vi.mock('@noble/hashes/scrypt.js', () => import('../helpers/fast-kdf.ts'));

describe('form', () => {
  it('shows the defaults and that no key is set', async () => {
    await setup();
    expect(field('Minimum reserve (MIN_RESERVE_SOL)').value).toBe('0.015');
    expect(field('Max attempts per wallet').value).toBe('3');
    expect(field(/^Price ceiling/u).value).toBe('50');
    expect(field('“No route” retry window').value).toBe('20');
    expect(field('Retry delay: first').value).toBe('500');
    expect(field('Retry delay: longest').value).toBe('2000');
    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Auto-lock after inactivity' }).value,
    ).toBe('off');
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /^One-shot/u }).checked).toBe(true);
    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Transaction explorer' }).value,
    ).toBe('solscan');
    expect(screen.getByText(/\/order limit: 60\/min \(\s*1\/s/u)).toBeTruthy();
    expect(screen.getAllByText('Not set.')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: /^Remove/u })).toBeNull();
  });

  it.each<[string | RegExp, string, string]>([
    [/^Price ceiling/u, '0', 'The price ceiling must be a whole number from 1 to 1000%.'],
    [/^Price ceiling/u, '1001', 'The price ceiling must be a whole number from 1 to 1000%.'],
    ['Max attempts per wallet', '11', 'Attempts must be a whole number from 1 to 10.'],
    ['Max attempts per wallet', 'three', 'Attempts must be a whole number from 1 to 10.'],
    [
      'Minimum reserve (MIN_RESERVE_SOL)',
      '0,004',
      'The minimum reserve must be between 0.005 and 1 SOL.',
    ],
    [
      'Minimum reserve (MIN_RESERVE_SOL)',
      'abc',
      'The minimum reserve must be between 0.005 and 1 SOL.',
    ],
    ['“No route” retry window', '500', 'The “no route” window must be between 1 and 120 s.'],
    [
      'Retry delay: longest',
      '400',
      'The longest retry delay cannot be shorter than the first one.',
    ],
  ])('%s = %s → English message, save disabled', async (label, value, message) => {
    const { user } = await setup();
    await retype(user, label, value);
    expect(screen.getByText(message)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it('every number field carries its unit inside the field and names it to screen readers', async () => {
    const { user } = await setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Jupiter plan' }), 'custom');
    const units: [string | RegExp, string][] = [
      ['/order limit (requests per minute)', '/min'],
      ['Minimum reserve (MIN_RESERVE_SOL)', 'SOL'],
      ['Max attempts per wallet', 'attempts'],
      [/^Price ceiling/u, '%'],
      ['“No route” retry window', 's'],
      ['Retry delay: first', 'ms'],
      ['Retry delay: longest', 'ms'],
      ['Sell part', '%'],
      ['Buy slippage', '%'],
      ['Sell slippage', '%'],
      ['Priority fee', 'SOL'],
    ];
    for (const [label, unit] of units) {
      const input = field(label);
      // the unit is drawn in the same box as the number, not beside or under it
      const box = input.closest('.k-num');
      expect(box?.querySelector('.k-num-unit')?.textContent, String(label)).toBe(unit);
      expect(input.getAttribute('aria-description'), String(label)).toBe(unit);
    }
    // the default buy amount switches between SOL and % with a button next to the field
    expect(
      screen.getByRole('button', { name: /^Unit of the default buy amount: SOL/u }).textContent,
    ).toBe('SOL');
    expect(document.querySelectorAll('.k-num')).toHaveLength(units.length + 1);

    // a wrong value still marks the field itself
    expect(field(/^Price ceiling/u).getAttribute('aria-invalid')).toBeNull();
    await retype(user, /^Price ceiling/u, '0');
    expect(field(/^Price ceiling/u).getAttribute('aria-invalid')).toBe('true');
    expect(field('Max attempts per wallet').getAttribute('aria-invalid')).toBeNull();
  });

  it('Jupiter plan sets the limit; "Custom" lets the user type it', async () => {
    const { user } = await setup();
    const plan = screen.getByRole('combobox', { name: 'Jupiter plan' });
    await user.selectOptions(plan, 'developer');
    expect(screen.getByText(/\/order limit: 600\/min \(\s*10\/s/u)).toBeTruthy();
    await user.selectOptions(plan, 'keyless');
    expect(screen.getByText(/\/order limit: 30\/min \(\s*0\.5\/s/u)).toBeTruthy();
    await user.selectOptions(plan, 'custom');
    await retype(user, '/order limit (requests per minute)', '0');
    expect(screen.getByText(/from 1 to 100000 requests per minute/u)).toBeTruthy();
    await retype(user, '/order limit (requests per minute)', '1200');
    expect(saveButton().disabled).toBe(false);
  });

  it('continuous mode needs confirming the warning', async () => {
    const { user } = await setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    const continuous = screen.getByRole<HTMLInputElement>('radio', { name: /^Continuous/u });
    await user.click(continuous);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(continuous.checked).toBe(false);
    confirm.mockReturnValueOnce(true);
    await user.click(continuous);
    expect(continuous.checked).toBe(true);
    expect(screen.getByText(/Continuous mode is on/u)).toBeTruthy();
  });
});

describe('VaultInfo in the UI', () => {
  it('has only flags for the keys', async () => {
    const { handler, user } = await setup();
    await enter(user, field('Helius API key'), HELIUS_KEY);
    await saveSettings(user);
    const status = (await handler.handle({ type: 'status' })) as { info: VaultFileResult['info'] };
    expect(status.info.apiKeys).toEqual({
      helius: true,
      jupiter: false,
      heliusRpcUrl: false,
      heliusWsUrl: false,
    });
    expect(
      JSON.stringify(status, (_k, v: unknown) => (typeof v === 'bigint' ? 0 : v)),
    ).not.toContain(HELIUS_KEY);
  });
});

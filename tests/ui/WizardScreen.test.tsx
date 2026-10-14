// @vitest-environment jsdom
/** The new fleet wizard: form validation and what blocks the fleet (BUNNDLY-42). Setup: WizardScreen.fixture.tsx. */
import { screen } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LOCKED, mockVault } from './fakes.ts';
import { enter, setupUser } from './user.ts';
import {
  PASSWORD,
  MNEMONIC_12,
  vaultWithPendingCreate,
  renderWizard,
  openWizard,
  field,
  fillValidForm,
  createButton,
  createRequests,
  fieldErrors,
  clickAndExpectNoFleet,
} from './WizardScreen.fixture.tsx';

describe('form validation', () => {
  it('wallet count must be an integer 1–100 (default 30)', async () => {
    const user = setupUser();
    const vault = mockVault(LOCKED);
    renderWizard(vault);
    await openWizard(user);
    expect(field('Number of wallets').value).toBe('30');
    await fillValidForm(user);
    expect(fieldErrors()).toEqual([]);

    for (const bad of ['0', '101', '1.5', '']) {
      await user.clear(field('Number of wallets'));
      if (bad !== '') await user.type(field('Number of wallets'), bad);
      expect(fieldErrors()).toEqual([
        'The number of wallets must be a whole number from 1 to 100.',
      ]);
      await clickAndExpectNoFleet(user, vault);
    }
    for (const good of ['1', '100']) {
      await user.clear(field('Number of wallets'));
      await user.type(field('Number of wallets'), good);
      expect(fieldErrors()).toEqual([]);
    }
    await user.click(createButton());
    expect(createRequests(vault).map((r) => r.walletCount)).toEqual([100]);
  });

  it.each(['a/b', '../x', 'CON', '.ukryta'])('fleet name %j is rejected', async (name) => {
    const user = setupUser();
    const vault = mockVault(LOCKED);
    renderWizard(vault);
    await openWizard(user);
    await fillValidForm(user);
    await user.clear(field('Fleet name'));
    await user.type(field('Fleet name'), name);
    expect(screen.getByText(/Invalid fleet name/u)).toBeTruthy();
    await clickAndExpectNoFleet(user, vault);
  });

  it('password needs 12 characters counted like core (graphemes after NFKC)', async () => {
    const user = setupUser();
    const vault = mockVault(LOCKED);
    renderWizard(vault);
    await openWizard(user);
    await fillValidForm(user, 'Ab1!Ab1!Ab1'); // 11 characters
    expect(fieldErrors()).toEqual(['The password must have at least 12 characters (now: 11).']);
    await clickAndExpectNoFleet(user, vault);

    // 11 × "ą" in NFD is 22 code points but 11 characters
    const nfd = 'ą'.normalize('NFD').repeat(11);
    await user.clear(field('Password'));
    await user.clear(field('Repeat the password'));
    await user.type(field('Password'), nfd);
    await user.type(field('Repeat the password'), nfd);
    expect(fieldErrors()).toEqual(['The password must have at least 12 characters (now: 11).']);
    await clickAndExpectNoFleet(user, vault);

    await user.type(field('Password'), 'X');
    await user.type(field('Repeat the password'), 'X');
    expect(fieldErrors()).toEqual([]);
    expect(screen.getByText(/Password strength:/u)).toBeTruthy();
    await user.click(createButton());
    expect(createRequests(vault).map((r) => r.password)).toEqual([`${nfd}X`]);
  });

  it('mismatched repeat blocks the button', async () => {
    const user = setupUser();
    const vault = mockVault(LOCKED);
    renderWizard(vault);
    await openWizard(user);
    await fillValidForm(user);
    await user.type(field('Repeat the password'), 'x');
    expect(fieldErrors()).toEqual(['The passwords do not match.']);
    await clickAndExpectNoFleet(user, vault);
  });
});

describe('what blocks the fleet is always said next to the field (BUNNDLY-42)', () => {
  const SHORT = 'Ab1!Ab1!Ab1'; // 11 characters

  it('an untouched form shows no messages; a click on the button shows all of them', async () => {
    const user = setupUser();
    const vault = mockVault(LOCKED);
    renderWizard(vault);
    await openWizard(user);
    expect(fieldErrors()).toEqual([]);
    expect(createButton().disabled).toBe(false);

    await clickAndExpectNoFleet(user, vault);
    expect(fieldErrors()).toEqual([
      'Enter a fleet name.',
      'The password must have at least 12 characters (now: 0).',
      'Repeat the password.',
    ]);
    // the first field to fix has the focus and points at its message
    const name = field('Fleet name');
    expect(document.activeElement).toBe(name);
    expect(name.getAttribute('aria-invalid')).toBe('true');
    const describedBy = name.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe('Enter a fleet name.');
  });

  it('leaving an empty field shows its message without touching the others', async () => {
    const user = setupUser();
    renderWizard(mockVault(LOCKED));
    await openWizard(user);
    await user.click(field('Fleet name'));
    await user.tab();
    expect(fieldErrors()).toEqual(['Enter a fleet name.']);
    await user.tab(); // leaves "Password"
    expect(fieldErrors()).toEqual([
      'Enter a fleet name.',
      'The password must have at least 12 characters (now: 0).',
    ]);
  });

  interface OneCondition {
    readonly title: string;
    readonly breakIt: (user: UserEvent) => Promise<void>;
    readonly message: string;
    readonly focused: string;
  }
  const conditions: OneCondition[] = [
    {
      title: 'wallet count',
      breakIt: async (user) => {
        await user.clear(field('Number of wallets'));
      },
      message: 'The number of wallets must be a whole number from 1 to 100.',
      focused: 'Number of wallets',
    },
    {
      title: 'empty fleet name',
      breakIt: async (user) => {
        await user.clear(field('Fleet name'));
      },
      message: 'Enter a fleet name.',
      focused: 'Fleet name',
    },
    {
      title: 'password under 12 characters',
      breakIt: async (user) => {
        await user.clear(field('Password'));
        await user.clear(field('Repeat the password'));
        await user.type(field('Password'), SHORT);
        await user.type(field('Repeat the password'), SHORT);
      },
      message: 'The password must have at least 12 characters (now: 11).',
      focused: 'Password',
    },
    {
      title: 'empty password repeat',
      breakIt: async (user) => {
        await user.clear(field('Repeat the password'));
      },
      message: 'Repeat the password.',
      focused: 'Repeat the password',
    },
    {
      title: 'different password repeat',
      breakIt: async (user) => {
        await user.type(field('Repeat the password'), 'x');
      },
      message: 'The passwords do not match.',
      focused: 'Repeat the password',
    },
    {
      title: 'import chosen but no mnemonic',
      breakIt: async (user) => {
        await user.click(
          screen.getByRole('checkbox', { name: /I already have a recovery phrase/u }),
        );
      },
      message: 'Enter the recovery phrase or untick the import.',
      focused: 'Recovery phrase',
    },
    {
      title: 'mnemonic with a wrong number of words',
      breakIt: async (user) => {
        await user.click(
          screen.getByRole('checkbox', { name: /I already have a recovery phrase/u }),
        );
        await user.type(field('Recovery phrase'), 'abandon abandon abandon');
      },
      message: 'The recovery phrase must have 12, 15, 18, 21 or 24 words (now: 3).',
      focused: 'Recovery phrase',
    },
  ];

  it.each(conditions)(
    'only $title is wrong: its message, no fleet',
    async ({ breakIt, message, focused }) => {
      const user = setupUser();
      const vault = mockVault(LOCKED);
      renderWizard(vault);
      await openWizard(user);
      await fillValidForm(user);
      await breakIt(user);
      await clickAndExpectNoFleet(user, vault);
      expect(fieldErrors()).toEqual([message]);
      expect(document.activeElement).toBe(field(focused));
    },
  );

  it('everything right: exactly one create request with the typed values', async () => {
    const user = setupUser();
    const { vault, gate, seen } = vaultWithPendingCreate();
    renderWizard(vault);
    await openWizard(user);
    await user.clear(field('Number of wallets'));
    await user.type(field('Number of wallets'), '7');
    await user.type(field('Fleet name'), 'Moja flota');
    await enter(user, field('Password'), PASSWORD);
    await enter(user, field('Repeat the password'), PASSWORD);
    expect(fieldErrors()).toEqual([]);
    await user.click(createButton());
    gate.resolve();
    await screen.findByRole('heading', { name: 'Fleet created' });
    // The fake browser keeps no data (fakes.ts), so the fleet is not remembered.
    expect(seen).toEqual([
      {
        type: 'create',
        fleetName: 'Moja flota',
        walletCount: 7,
        password: PASSWORD,
        remember: false,
      },
    ]);
  });

  it('12 words, a name and a 12-character password create the fleet; without the name they do not', async () => {
    const twelve = 'Ab1!Ab1!Ab1!';
    const user = setupUser();
    const { vault, gate, seen } = vaultWithPendingCreate();
    renderWizard(vault);
    await openWizard(user);
    await user.type(field('Password'), twelve);
    await user.type(field('Repeat the password'), twelve);
    await user.click(screen.getByRole('checkbox', { name: /I already have a recovery phrase/u }));
    await user.type(field('Recovery phrase'), MNEMONIC_12);

    await clickAndExpectNoFleet(user, vault);
    expect(fieldErrors()).toEqual(['Enter a fleet name.']);
    expect(document.activeElement).toBe(field('Fleet name'));

    await user.type(field('Fleet name'), 'Flota testowa');
    expect(fieldErrors()).toEqual([]);
    await user.click(createButton());
    gate.resolve();
    await screen.findByRole('heading', { name: 'Fleet created' });
    expect(seen).toEqual([
      {
        type: 'create',
        fleetName: 'Flota testowa',
        walletCount: 30,
        password: twelve,
        mnemonic: MNEMONIC_12,
        remember: false,
      },
    ]);
  });

  it('says that the import is optional and what it does', async () => {
    const user = setupUser();
    renderWizard(mockVault(LOCKED));
    await openWizard(user);
    const hint = screen.getByText(/The import is optional/u).textContent;
    expect(hint).toContain('the app generates a new recovery phrase (24 words)');
    expect(hint).toContain('Phantom');
    expect(hint).toContain("m/44'/501'/{i}'/0'");
  });
});

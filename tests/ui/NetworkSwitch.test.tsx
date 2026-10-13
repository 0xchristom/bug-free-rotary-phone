// @vitest-environment jsdom
/** Mainnet / Devnet in the header (BUNNDLY-44): the whole app with a fake vault. */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/ui/App.tsx';
import type { WatchStatus } from '../../src/watcher/watch.ts';
import type { VaultBalances, VaultRequest, VaultStatus } from '../../src/worker/protocol.ts';
import { LOCKED, fleetInfo, mockStorage, mockVault, unlocked } from './fakes.ts';

const CREATOR = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(status: VaultStatus, storageMode: 'directory' | 'download' = 'directory') {
  const vault = mockVault(status);
  const storage = mockStorage(storageMode);
  const user = userEvent.setup();
  render(<App vault={vault.client} storage={storage.env} statusPollMs={20} />);
  const requests = (type: VaultRequest['type']): VaultRequest[] =>
    vault.request.mock.calls.map(([r]) => r).filter((r) => r.type === type);
  return { vault, storage, user, requests };
}

const group = async (): Promise<HTMLElement> => screen.findByRole('group', { name: 'Network' });
const button = async (name: 'Mainnet' | 'Devnet'): Promise<HTMLButtonElement> =>
  within(await group()).getByRole('button', { name });
const pressed = async (): Promise<string[]> =>
  within(await group())
    .getAllByRole('button', { pressed: true })
    .map((b) => b.textContent);

function withBuy(): VaultStatus {
  return {
    ...unlocked(true),
    buy: { runId: 1, mint: MINT, dryRun: true, wallets: 3, accepting: true },
  };
}

function withWatch(): VaultStatus {
  const watch: WatchStatus = {
    creator: CREATOR,
    armedAt: '2026-10-12T10:00:00.000Z',
    mode: 'one-shot',
    armed: true,
    connection: 'connected',
    attempt: 0,
    lastMessageAt: null,
    detections: [],
    queued: [],
  };
  return { ...unlocked(true), watch };
}

function onDevnet(): VaultStatus {
  const info = fleetInfo();
  return {
    ...unlocked(),
    network: 'devnet',
    info: {
      ...info,
      apiKeys: { ...info.apiKeys, helius: true },
      settings: {
        ...info.settings,
        maxSpend: info.wallets.map((w) => ({ index: w.index, lamports: 10_000_000n })),
        global: { ...info.settings.global, network: 'devnet' },
      },
    },
  };
}

describe('the button', () => {
  it('shows the current network on every screen, with the exact labels and no “Solana”', async () => {
    const { user } = setup(unlocked());
    expect(await pressed()).toEqual(['Mainnet']);
    expect(
      within(await group())
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Mainnet', 'Devnet']);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await pressed()).toEqual(['Mainnet']);
    expect(document.body.textContent).not.toMatch(/Solana\s+(Mainnet|Devnet)/iu);
  });

  it('locked: the network is shown, the switch waits for an open fleet', async () => {
    const { user, requests } = setup(LOCKED);
    expect(await pressed()).toEqual(['Mainnet']);
    expect((await button('Devnet')).disabled).toBe(true);
    expect((await group()).title).toMatch(/open a fleet/u);
    await user.click(screen.getByRole('button', { name: 'Create a new fleet' }));
    expect(await pressed()).toEqual(['Mainnet']);
    expect(requests('setNetwork')).toEqual([]);
  });

  it('a fleet saved on devnet opens with Devnet pressed and marked', async () => {
    setup(onDevnet());
    await waitFor(async () => {
      expect(await pressed()).toEqual(['Devnet']);
    });
    expect((await group()).className).toContain('devnet');
  });
});

describe('switching', () => {
  it('one click: the vault gets the network, the button follows, the fleet file is offered', async () => {
    const { user, requests, storage } = setup(unlocked());
    await user.click(await button('Devnet'));
    await waitFor(async () => {
      expect(await pressed()).toEqual(['Devnet']);
    });
    expect(requests('setNetwork')).toEqual([{ type: 'setNetwork', network: 'devnet' }]);
    expect((await group()).className).toContain('devnet');

    expect(
      screen.getByText(
        /Devnet is set for this session only\. Save the updated fleet file: without it the choice is lost when you close the tab/u,
      ),
    ).toBeTruthy();
    await user.click(
      screen.getByRole('button', { name: 'Save the fleet file with the new network' }),
    );
    expect(await screen.findByText(/Saved .* with the new network/u)).toBeTruthy();
    expect([...storage.files.values()]).toEqual(['{"network":"devnet"}']);

    // A click on the network already chosen asks for nothing.
    await user.click(await button('Devnet'));
    expect(requests('setNetwork')).toHaveLength(1);
  });

  it('there and back without saving: the file on disk is right again, nothing is asked', async () => {
    const { user, requests } = setup(unlocked());
    await user.click(await button('Devnet'));
    expect(await screen.findByText(/Devnet is set for this session only/u)).toBeTruthy();
    await user.click(await button('Mainnet'));
    await waitFor(async () => {
      expect(await pressed()).toEqual(['Mainnet']);
    });
    expect(requests('setNetwork')).toHaveLength(2);
    await waitFor(() => {
      expect(screen.queryByText(/is set for this session only/u)).toBeNull();
    });
    expect(
      screen.queryByRole('button', { name: 'Save the fleet file with the new network' }),
    ).toBeNull();
  });

  it('a running buy: the network stays, a message says why, nothing is sent', async () => {
    const { user, requests } = setup(withBuy());
    await user.click(await button('Devnet'));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /The network cannot change during a buy/u,
    );
    expect(await pressed()).toEqual(['Mainnet']);
    expect(requests('setNetwork')).toEqual([]);
  });

  it('an armed watcher: the network stays, a message says why, nothing is sent', async () => {
    const { user, requests } = setup(withWatch());
    await user.click(await button('Devnet'));
    expect(
      (await screen.findAllByRole('alert')).some((a) =>
        /The network cannot change while the watcher is armed/u.test(a.textContent),
      ),
    ).toBe(true);
    expect(await pressed()).toEqual(['Mainnet']);
    expect(requests('setNetwork')).toEqual([]);
  });

  it('the vault refuses (a buy began a moment ago): the same message, the network stays', async () => {
    const { vault, user } = setup(unlocked());
    await pressed();
    // The UI still shows no buy; the worker already runs one.
    const original = vault.request.getMockImplementation();
    vault.request.mockImplementation((req, options) => {
      if (req.type === 'setNetwork') vault.setStatus(withBuy());
      return original ? original(req, options) : Promise.reject(new Error('no vault'));
    });
    await user.click(await button('Devnet'));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /The network cannot change during a buy/u,
    );
    expect(await pressed()).toEqual(['Mainnet']);
  });

  it('back to mainnet with DRY-RUN off asks first; “no” changes nothing', async () => {
    const devnet = onDevnet();
    if (!devnet.info) throw new Error('no fleet');
    const live: VaultStatus = {
      ...devnet,
      info: {
        ...devnet.info,
        settings: {
          ...devnet.info.settings,
          global: { ...devnet.info.settings.global, dryRun: false },
        },
      },
    };
    const { user, requests } = setup(live);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await waitFor(async () => {
      expect(await pressed()).toEqual(['Devnet']);
    });
    await user.click(await button('Mainnet'));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toMatch(/switching to Mainnet with DRY-RUN off/u);
    expect(requests('setNetwork')).toEqual([]);
    confirm.mockReturnValue(true);
    await user.click(await button('Mainnet'));
    await waitFor(async () => {
      expect(await pressed()).toEqual(['Mainnet']);
    });
  });
});

describe('balances follow the network', () => {
  it('after the switch the old balances are gone and the next read is the new network', async () => {
    const vault = mockVault(unlocked());
    const original = vault.request.getMockImplementation();
    let network: 'mainnet' | 'devnet' = 'mainnet';
    /** A mainnet read asked before the switch, answered after it. */
    let lateMainnet: ((value: VaultBalances) => void) | null = null;
    let holdNext = false;
    const balances = (on: 'mainnet' | 'devnet'): VaultBalances => ({
      network: on,
      balances: [0, 1, 2].map((index) => ({
        index,
        lamports: on === 'mainnet' ? 1_500_000_000n : 7_000_000_000n,
      })),
      source: 'helius',
      fetchedAt: '2026-10-12T12:00:00.000Z',
    });
    vault.request.mockImplementation((req, options) => {
      if (req.type === 'refreshBalances') {
        if (holdNext) {
          holdNext = false;
          return new Promise<VaultBalances>((resolve) => {
            lateMainnet = resolve;
          });
        }
        return Promise.resolve(balances(network));
      }
      if (req.type === 'setNetwork') network = req.network;
      return original ? original(req, options) : Promise.reject(new Error('no vault'));
    });
    const user = userEvent.setup();
    render(
      <App
        vault={vault.client}
        storage={mockStorage().env}
        statusPollMs={20}
        balanceRefreshMs={3_600_000}
      />,
    );
    expect(await screen.findAllByText('1.5')).toHaveLength(3);

    holdNext = true;
    await user.click(screen.getByRole('button', { name: 'Refresh balances' }));
    await waitFor(() => {
      expect(lateMainnet).not.toBeNull();
    });
    await user.click(await button('Devnet'));
    // Devnet is on screen: no mainnet balance may be shown as current.
    await waitFor(async () => {
      expect(await pressed()).toEqual(['Devnet']);
    });
    expect(screen.queryAllByText('1.5')).toEqual([]);

    // The mainnet answer arrives late, while the devnet read that follows is still on its
    // way: nothing from mainnet may fill the gap.
    const releaseMainnet = lateMainnet as ((value: VaultBalances) => void) | null;
    lateMainnet = null;
    holdNext = true;
    releaseMainnet?.(balances('mainnet'));
    await waitFor(() => {
      expect(lateMainnet).not.toBeNull();
    });
    expect(screen.queryAllByText('1.5')).toEqual([]);
    expect(screen.getByText('Balances: loading…')).toBeTruthy();
    (lateMainnet as ((value: VaultBalances) => void) | null)?.(balances('devnet'));
    expect(await screen.findAllByText('7')).toHaveLength(3);
    expect(screen.queryAllByText('1.5')).toEqual([]);
  });
});

describe('balances follow the network', () => {
  it('balances the vault read on another network than the one asked for are not shown', async () => {
    const vault = mockVault(unlocked());
    const original = vault.request.getMockImplementation();
    const read = (network: 'mainnet' | 'devnet', lamports: bigint): VaultBalances => ({
      network,
      balances: [0, 1, 2].map((index) => ({ index, lamports })),
      source: 'helius',
      fetchedAt: '2026-10-12T12:00:00.000Z',
    });
    // The screen asks on mainnet. The first answer says it was read on devnet (the switch
    // landed in the vault between the question and the read), the second is mainnet's.
    const answers = [read('devnet', 7_000_000_000n), read('mainnet', 1_500_000_000n)];
    let answered = 0;
    vault.request.mockImplementation((req, options) => {
      if (req.type === 'refreshBalances') {
        const answer = answers[answered] ?? read('mainnet', 1_500_000_000n);
        answered += 1;
        return Promise.resolve(answer);
      }
      return original ? original(req, options) : Promise.reject(new Error('no vault'));
    });
    const user = userEvent.setup();
    render(
      <App
        vault={vault.client}
        storage={mockStorage().env}
        statusPollMs={20}
        balanceRefreshMs={3_600_000}
      />,
    );
    await waitFor(() => {
      expect(answered).toBe(1);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(await pressed()).toEqual(['Mainnet']);
    // 7 SOL is devnet's: not in the table, where “max spend as % of the balance” reads it.
    expect(screen.queryAllByText('7')).toEqual([]);
    expect(screen.getByText('Balances: loading…')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Refresh balances' }));
    expect(await screen.findAllByText('1.5')).toHaveLength(3);
    expect(screen.queryAllByText('7')).toEqual([]);
    expect(answered).toBe(2);
  });
});

describe('an unsaved fleet file on the screen', () => {
  it('the network stays and a message says why; the message goes once the file is saved', async () => {
    const vault = mockVault(LOCKED, (req) =>
      Promise.resolve({
        fileText: '{"version":1,"encrypted":true}',
        info: fleetInfo(req.walletCount, req.fleetName),
      }),
    );
    const storage = mockStorage();
    // No pause between keystrokes: on Windows each one costs a 16 ms timer.
    const user = userEvent.setup({ delay: null });
    render(<App vault={vault.client} storage={storage.env} statusPollMs={20} />);
    await user.click(await screen.findByRole('button', { name: 'Create a new fleet' }));
    await user.type(screen.getByLabelText('Fleet name'), 'Nowa');
    await user.type(screen.getByLabelText('Password'), 'Tk9#mQ2!vR8&');
    await user.type(screen.getByLabelText('Repeat the password'), 'Tk9#mQ2!vR8&');
    await user.click(screen.getByRole('button', { name: 'Create the fleet' }));
    await screen.findByRole('heading', { name: 'Fleet created' });

    await waitFor(async () => {
      expect((await button('Devnet')).disabled).toBe(false);
    });
    await user.click(await button('Devnet'));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Save the table changes and the updated fleet file first, then change the network.',
    );
    expect(await pressed()).toEqual(['Mainnet']);
    expect(vault.calls('setNetwork')).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Save the fleet file' }));
    await screen.findByRole('heading', { name: 'Fleet file saved' });
    // The screen reports the saved file in an effect, one render after the heading.
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    await user.click(screen.getByRole('button', { name: 'Go to the fleet' }));
    await screen.findByRole('heading', { name: 'Fleet' });
    expect(screen.queryByText(/then change the network/u)).toBeNull();

    // Nothing unsaved is left: the switch works now.
    await user.click(await button('Devnet'));
    await waitFor(async () => {
      expect(await pressed()).toEqual(['Devnet']);
    });
    expect(vault.calls('setNetwork')).toBe(1);
  });
});

describe('devnet has no buy', () => {
  it('“Buy now” and ARM are off with one sentence; no startBuy and no arm leave the UI', async () => {
    const { user, requests } = setup(onDevnet());
    const sentence = 'Buying and the watcher are off on Devnet: Jupiter works on Mainnet only.';
    const buy = await screen.findByRole<HTMLButtonElement>('button', { name: 'Buy now' });
    expect(buy.disabled).toBe(true);
    expect(screen.getByText(sentence)).toBeTruthy();
    await user.click(buy);

    await user.click(screen.getByRole('button', { name: 'Mode B: watch a creator' }));
    await user.type(screen.getByLabelText(/Creator address/u), CREATOR);
    const arm = screen.getByRole<HTMLButtonElement>('button', { name: 'ARM' });
    expect(arm.disabled).toBe(true);
    expect(screen.getByText(sentence)).toBeTruthy();
    await user.click(arm);

    expect(requests('startBuy')).toEqual([]);
    expect(requests('arm')).toEqual([]);
  });

  it('on mainnet the same fleet has no such sentence', async () => {
    const devnet = onDevnet();
    if (!devnet.info) throw new Error('no fleet');
    const { settings } = devnet.info;
    setup({
      ...devnet,
      network: 'mainnet',
      info: {
        ...devnet.info,
        settings: { ...settings, global: { ...settings.global, network: 'mainnet' } },
      },
    });
    await screen.findByRole('button', { name: 'Buy now' });
    expect(screen.queryByText(/off on Devnet/u)).toBeNull();
  });
});

describe('confirmations name the network', () => {
  it('switching to live mode says which network will spend SOL', async () => {
    const { user } = setup(unlocked());
    await user.click(await screen.findByRole('button', { name: 'Switch to live mode…' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('Network: Mainnet.');
  });
});

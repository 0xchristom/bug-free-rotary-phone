// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Button,
  Input,
  Modal,
  Popover,
  ToastProvider,
  Tooltip,
  useToast,
} from '../../../src/ui/kit/index.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function focused(): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  return active.textContent === '' ? active.getAttribute('id') : active.textContent;
}

describe('Modal', () => {
  function Screen({ dismissible = true }: { dismissible?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button
          onClick={() => {
            setOpen(true);
          }}
        >
          Plain export
        </Button>
        <Button>Other</Button>
        <Modal
          open={open}
          onClose={() => {
            setOpen(false);
          }}
          title="Plain export"
          tone="danger"
          dismissible={dismissible}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setOpen(false);
                }}
              >
                Cancel
              </Button>
              <Button variant="danger">Export</Button>
            </>
          }
        >
          <label htmlFor="pw">Password</label>
          <Input id="pw" type="password" />
        </Modal>
      </>
    );
  }

  async function openModal(): Promise<HTMLElement> {
    await userEvent.click(screen.getByRole('button', { name: 'Plain export' }));
    return screen.getByRole('dialog', { name: 'Plain export' });
  }

  it('is not in the page until opened; opening names it and moves the focus inside', async () => {
    render(<Screen />);
    expect(screen.queryByRole('dialog')).toBeNull();
    const dialog = await openModal();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(screen.getByLabelText('Password'));
  });

  it('Tab and Shift+Tab stay inside the dialog', async () => {
    render(<Screen />);
    await openModal();
    const seen: (string | null)[] = [focused()];
    for (let i = 0; i < 4; i++) {
      await userEvent.tab();
      seen.push(focused());
    }
    // 3 stops (field, Cancel, Export), then round again; never "Other" or the opener.
    expect(seen).toEqual(['pw', 'Cancel', 'Export', 'pw', 'Cancel']);

    await userEvent.tab({ shift: true });
    await userEvent.tab({ shift: true });
    expect(focused()).toBe('Export');
  });

  it('Esc closes it and gives the focus back to the control that opened it', async () => {
    render(<Screen />);
    await openModal();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Plain export' }));
  });

  it('a button inside that closes it returns the focus too', async () => {
    render(<Screen />);
    await openModal();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Plain export' }));
  });

  it('a press on the backdrop closes it, a press inside does not', async () => {
    render(<Screen />);
    const dialog = await openModal();
    await userEvent.click(dialog);
    expect(screen.queryByRole('dialog')).not.toBeNull();
    const backdrop = dialog.parentElement;
    if (!backdrop) throw new Error('no backdrop');
    await userEvent.click(backdrop);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('not dismissible: Esc and the backdrop leave it open', async () => {
    render(<Screen dismissible={false} />);
    const dialog = await openModal();
    await userEvent.keyboard('{Escape}');
    const backdrop = dialog.parentElement;
    if (!backdrop) throw new Error('no backdrop');
    await userEvent.click(backdrop);
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });
});

describe('Popover', () => {
  function Bar({ onClose }: { onClose?: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Popover
          open={open}
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
          label="Create wallets"
          trigger={
            <Button
              onClick={() => {
                setOpen((o) => !o);
              }}
            >
              Create wallets
            </Button>
          }
        >
          <label htmlFor="count">How many</label>
          <Input id="count" defaultValue="3" />
          <Button variant="primary">Create</Button>
        </Popover>
        <Button>Elsewhere</Button>
      </>
    );
  }
  const trigger = (): HTMLElement => screen.getByRole('button', { name: 'Create wallets' });

  it('opens under its trigger with the focus on the first field', async () => {
    render(<Bar />);
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(trigger());
    expect(screen.getByRole('dialog', { name: 'Create wallets' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('How many'));
  });

  it('keeps the focus where the user put it when the parent re-renders', async () => {
    const { rerender } = render(<Bar />);
    await userEvent.click(trigger());
    screen.getByRole('button', { name: 'Create' }).focus();
    rerender(<Bar />);
    expect(focused()).toBe('Create');
  });

  it('Esc closes it and returns the focus to the trigger', async () => {
    const onClose = vi.fn();
    render(<Bar onClose={onClose} />);
    await userEvent.click(trigger());
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger());
  });

  it('a press outside closes it; a press inside does not', async () => {
    const onClose = vi.fn();
    render(<Bar onClose={onClose} />);
    await userEvent.click(trigger());
    await userEvent.click(screen.getByLabelText('How many'));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('while closed it does not listen for presses', async () => {
    const onClose = vi.fn();
    render(<Bar onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Toast', () => {
  function Copy() {
    const toast = useToast();
    return (
      <Button
        onClick={() => {
          toast({ title: 'Address copied', detail: '3ij4…3e3P', tone: 'ok' });
        }}
      >
        Copy
      </Button>
    );
  }

  it('shows in a polite live region and leaves after its lifetime', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider lifeMs={4_200}>
        <Copy />
      </ToastProvider>,
    );
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('');

    act(() => {
      screen.getByRole('button', { name: 'Copy' }).click();
    });
    expect(region.textContent).toBe('Address copied3ij4…3e3P');
    expect(screen.getByText('Address copied').parentElement?.dataset.tone).toBe('ok');

    act(() => {
      vi.advanceTimersByTime(4_199);
    });
    expect(region.textContent).toBe('Address copied3ij4…3e3P');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(region.textContent).toBe('');
  });

  it('each toast has its own clock', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider lifeMs={1_000}>
        <Copy />
      </ToastProvider>,
    );
    const click = (): void => {
      act(() => {
        screen.getByRole('button', { name: 'Copy' }).click();
      });
    };
    click();
    act(() => {
      vi.advanceTimersByTime(600);
    });
    click();
    expect(screen.getAllByText('Address copied')).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getAllByText('Address copied')).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.queryByText('Address copied')).toBeNull();
  });

  it('without a provider a toast is dropped, the click still works', async () => {
    render(<Copy />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(screen.queryByText('Address copied')).toBeNull();
  });
});

describe('Tooltip', () => {
  function Tip() {
    return (
      <Tooltip text="Buy needs a mint the vault has checked">
        <Button>Buy now</Button>
      </Tooltip>
    );
  }
  const button = (): HTMLElement => screen.getByRole('button', { name: 'Buy now' });

  it('shows on hover as the description of its control and hides on leave', async () => {
    render(<Tip />);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(button().hasAttribute('aria-describedby')).toBe(false);

    await userEvent.hover(button());
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe('Buy needs a mint the vault has checked');
    expect(button().getAttribute('aria-describedby')).toBe(tip.id);

    await userEvent.unhover(button());
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(button().hasAttribute('aria-describedby')).toBe(false);
  });

  it('shows on keyboard focus; Esc hides it and keeps the focus', async () => {
    render(<Tip />);
    await userEvent.tab();
    expect(document.activeElement).toBe(button());
    expect(screen.getByRole('tooltip')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(document.activeElement).toBe(button());
  });
});

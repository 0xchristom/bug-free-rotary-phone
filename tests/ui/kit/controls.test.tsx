// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Avatar,
  Button,
  Checkbox,
  Chip,
  CloseIcon,
  IconButton,
  Input,
  NumberInput,
  ProgressBar,
  Segmented,
  Skeleton,
} from '../../../src/ui/kit/index.ts';
import { avatarPattern } from '../../../src/ui/kit/avatar-pattern.ts';

afterEach(cleanup);

describe('Button', () => {
  it('is a plain button by default: a click inside a form does not submit it', async () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => {
      event.preventDefault();
    });
    const onClick = vi.fn();
    render(
      <form onSubmit={onSubmit}>
        <Button onClick={onClick}>Cancel</Button>
        <Button type="submit" variant="primary">
          Create
        </Button>
      </form>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('loading: keeps its name, reports aria-busy and ignores clicks', async () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();

    rerender(<Button onClick={onClick}>Save</Button>);
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('aria-busy')).toBe(false);
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('the shortcut key is shown but is not part of the accessible name', () => {
    render(
      <Button variant="success" shortcut="B">
        Buy
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Buy' });
    expect(button.textContent).toBe('BuyB');
    expect(button.querySelector('kbd')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('IconButton', () => {
  it('takes its accessible name and tooltip from the label', async () => {
    const onClick = vi.fn();
    render(<IconButton label="Copy address" icon={<CloseIcon />} onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Copy address' });
    expect(button.getAttribute('title')).toBe('Copy address');
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not compile without a label (checked by npm run typecheck)', () => {
    // @ts-expect-error `label` is required: an icon alone has no accessible name.
    render(<IconButton icon={<CloseIcon />} />);
    // @ts-expect-error `aria-label` is not a way around it: the name is the `label` prop.
    render(<IconButton aria-label="Close" icon={<CloseIcon />} />);
    // Both render nameless, which is exactly what the type forbids.
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      null,
      null,
    ]);
  });
});

describe('Segmented', () => {
  function Net({ onChange }: { onChange: (v: string) => void }) {
    const [value, setValue] = useState<'mainnet' | 'devnet'>('mainnet');
    return (
      <Segmented
        label="Network"
        value={value}
        options={[
          { value: 'mainnet', label: 'Mainnet' },
          { value: 'devnet', label: 'Devnet' },
        ]}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
    );
  }

  it('marks the current choice and reports only a change', async () => {
    const onChange = vi.fn();
    render(<Net onChange={onChange} />);
    const group = screen.getByRole('group', { name: 'Network' });
    const pressed = (): (string | null)[] =>
      [...group.querySelectorAll('button')].map((b) => b.getAttribute('aria-pressed'));
    expect(pressed()).toEqual(['true', 'false']);

    await userEvent.click(screen.getByRole('button', { name: 'Mainnet' }));
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Devnet' }));
    expect(onChange.mock.calls).toEqual([['devnet']]);
    expect(pressed()).toEqual(['false', 'true']);
  });

  it('a disabled option cannot be picked', async () => {
    const onChange = vi.fn();
    render(
      <Segmented
        label="Mode"
        value="a"
        options={[
          { value: 'a', label: 'Mode A' },
          { value: 'b', label: 'Mode B', disabled: true, title: 'Not during a buy' },
        ]}
        onChange={onChange}
      />,
    );
    const b = screen.getByRole<HTMLButtonElement>('button', { name: 'Mode B' });
    expect(b.disabled).toBe(true);
    await userEvent.click(b);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Checkbox', () => {
  it('mixed shows as indeterminate and a click on it selects all', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Checkbox aria-label="Select all wallets" checked="mixed" onChange={onChange} />,
    );
    const box = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Select all wallets' });
    expect(box.indeterminate).toBe(true);
    expect(box.checked).toBe(false);
    await userEvent.click(box);
    expect(onChange.mock.calls).toEqual([[true]]);

    rerender(<Checkbox aria-label="Select all wallets" checked onChange={onChange} />);
    expect(box.indeterminate).toBe(false);
    expect(box.checked).toBe(true);
    await userEvent.click(box);
    expect(onChange.mock.calls).toEqual([[true], [false]]);

    rerender(<Checkbox aria-label="Select all wallets" checked={false} onChange={onChange} />);
    expect(box.indeterminate).toBe(false);
    expect(box.checked).toBe(false);
  });

  it('is controlled: without a new value from the parent the box does not flip', async () => {
    render(<Checkbox aria-label="Wallet 1" checked={false} onChange={() => undefined} />);
    const box = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Wallet 1' });
    await userEvent.click(box);
    expect(box.checked).toBe(false);
  });
});

describe('Input and NumberInput', () => {
  it('Input: text by default, invalid sets aria-invalid, typing reaches onChange', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <label>
        Fleet name
        <Input onChange={onChange} />
      </label>,
    );
    const input = screen.getByLabelText<HTMLInputElement>('Fleet name');
    expect(input.type).toBe('text');
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    await userEvent.type(input, 'ab');
    expect(onChange).toHaveBeenCalledTimes(2);

    rerender(
      <label>
        Fleet name
        <Input invalid onChange={onChange} />
      </label>,
    );
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('NumberInput: a text field with a decimal keypad; the unit is shown, not announced', () => {
    render(
      <>
        <label htmlFor="spend">Max spend (SOL)</label>
        <NumberInput id="spend" unit="SOL" defaultValue="0.1" invalid />
      </>,
    );
    const input = screen.getByLabelText<HTMLInputElement>('Max spend (SOL)');
    expect(input.type).toBe('text');
    expect(input.inputMode).toBe('decimal');
    expect(input.value).toBe('0.1');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const unit = input.nextElementSibling;
    expect(unit?.textContent).toBe('SOL');
    expect(unit?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('ProgressBar', () => {
  function bar(): HTMLElement {
    return screen.getByRole('progressbar', { name: 'Buy progress' });
  }
  function width(): string {
    const fill = bar().firstElementChild;
    return fill instanceof HTMLElement ? fill.style.width : '';
  }

  it('reports the value and draws the share of max', () => {
    render(
      <ProgressBar label="Buy progress" value={3} max={8} valueText="3 of 8 wallets" tone="run" />,
    );
    expect(bar().getAttribute('aria-valuenow')).toBe('3');
    expect(bar().getAttribute('aria-valuemin')).toBe('0');
    expect(bar().getAttribute('aria-valuemax')).toBe('8');
    expect(bar().getAttribute('aria-valuetext')).toBe('3 of 8 wallets');
    expect(bar().dataset.tone).toBe('run');
    expect(width()).toBe('37.5%'); // 3 / 8
  });

  it.each([
    [150, 100, '100', '100%'],
    [-5, 100, '0', '0%'],
    [Number.NaN, 100, '0', '0%'],
    [4, 0, '0', '0%'],
  ])('value %s of %s is clamped to %s (%s wide)', (value, max, now, wide) => {
    render(<ProgressBar label="Buy progress" value={value} max={max} />);
    expect(bar().getAttribute('aria-valuenow')).toBe(now);
    expect(width()).toBe(wide);
  });
});

describe('Chip and Skeleton', () => {
  it('Chip carries its tone next to the text; the dot is decoration', () => {
    render(
      <Chip tone="ok" dot>
        Bought
      </Chip>,
    );
    const chip = screen.getByText('Bought');
    expect(chip.dataset.tone).toBe('ok');
    expect(chip.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });

  it('Skeleton is hidden from screen readers and takes a width', () => {
    const { container } = render(<Skeleton width="8ch" />);
    const skeleton = container.firstElementChild;
    expect(skeleton?.getAttribute('aria-hidden')).toBe('true');
    expect(skeleton instanceof HTMLElement ? skeleton.style.width : '').toBe('8ch');
  });
});

describe('Avatar', () => {
  /** Rows of the 5×5 grid as text, `#` filled. */
  function grid(seed: string): string[] {
    const rows = Array.from({ length: 5 }, () => ['.', '.', '.', '.', '.']);
    for (const [x, y] of avatarPattern(seed).cells) {
      const row = rows[y];
      if (row) row[x] = '#';
    }
    return rows.map((row) => row.join(''));
  }

  // Expected pictures and hues computed by a separate implementation (Python, big integers
  // masked to 32 bits) of the same recipe as the mockup.
  it.each([
    ['3ij4bSQqPvWcVM8QKViys7NNC5hA44AAyGxXQSDp3e3P', 168, '.....|##.##|##.##|#...#|#.#.#'],
    ['fleet-alpha', 343, '.###.|#.#.#|.###.|.....|#####'],
    ['', 0, '.....|#.#.#|##.##|.#.#.|#.#.#'],
  ])('%s gives hue %s and a fixed picture', (seed, hue, picture) => {
    expect(avatarPattern(seed).hue).toBe(hue);
    expect(grid(seed).join('|')).toBe(picture);
  });

  it('every picture is its own mirror image', () => {
    for (const seed of ['a', 'Wallet 7', '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin']) {
      for (const row of grid(seed)) expect(Array.from(row).reverse().join('')).toBe(row);
    }
  });

  it('draws one square per filled cell and passes the hue to the stylesheet', () => {
    const { container } = render(<Avatar seed="fleet-alpha" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    // '.###.|#.#.#|.###.|.....|#####' (see above), row by row as "x,y"
    const squares = [
      ...(svg?.querySelector('path')?.getAttribute('d') ?? '').matchAll(/M(\d) (\d)h1v1h-1z/gu),
    ].map(([, x, y]) => `${String(x)},${String(y)}`);
    expect(squares.sort()).toEqual(
      [
        ...['1,0', '2,0', '3,0'],
        ...['0,1', '2,1', '4,1'],
        ...['1,2', '2,2', '3,2'],
        ...['0,4', '1,4', '2,4', '3,4', '4,4'],
      ].sort(),
    );
    expect(svg?.children).toHaveLength(1);
    expect(svg?.style.getPropertyValue('--ava-hue')).toBe('343');
  });
});

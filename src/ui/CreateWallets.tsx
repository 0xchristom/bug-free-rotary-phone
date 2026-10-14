import { useId, useState, type SyntheticEvent } from 'react';
import { Button, Input, PlusIcon, Popover } from './kit/index.ts';

export interface CreateWalletsProps {
  /** How many more wallets fit in the fleet. */
  readonly room: number;
  /** The fleet limit, for the message. */
  readonly limit: number;
  /** Why wallets cannot be created right now; shown next to the button. */
  readonly blocked: string | null;
  /** Creates the wallets; resolves to false when it failed (the screen shows why). */
  readonly onCreate: (count: number) => Promise<boolean>;
}

/** 1 to `room`, digits only; null for anything else. */
function parseCount(text: string, room: number): number | null {
  if (!/^\d{1,4}$/u.test(text.trim())) return null;
  const count = Number(text.trim());
  return count >= 1 && count <= room ? count : null;
}

/** "Create wallets": a count, one click (SPEC 11.1). The names follow in order. */
export function CreateWallets({ room, limit, blocked, onCreate }: CreateWalletsProps) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const count = parseCount(text, room);
  const outOfRange = text.trim() !== '' && count === null;

  const close = (): void => {
    setOpen(false);
    setText('');
  };

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (count === null || busy || blocked !== null) return;
    setBusy(true);
    try {
      if (await onCreate(count)) close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {blocked !== null && <span className="muted">{blocked}</span>}
      <Popover
        open={open && blocked === null}
        onClose={close}
        label="Create wallets"
        trigger={
          <Button
            id={`${ids}-open`}
            size="sm"
            icon={<PlusIcon />}
            disabled={blocked !== null}
            aria-expanded={open && blocked === null}
            onClick={() => {
              setOpen((was) => !was);
            }}
          >
            Create wallets
          </Button>
        }
      >
        <form className="pop-form" onSubmit={(e) => void submit(e)} noValidate>
          <h3>Create wallets</h3>
          <p className="hint">
            New wallets are named in order. The updated fleet file must be saved afterwards.
          </p>
          <label htmlFor={`${ids}-count`}>How many</label>
          <Input
            id={`${ids}-count`}
            inputMode="numeric"
            autoComplete="off"
            value={text}
            invalid={outOfRange}
            aria-describedby={`${ids}-help`}
            onChange={(e) => {
              setText(e.target.value);
            }}
          />
          <p className={outOfRange ? 'field-error' : 'hint'} id={`${ids}-help`}>
            You can create 1 to {room} wallets (at most {limit} in total).
          </p>
          <div className="actions end">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                close();
                document.getElementById(`${ids}-open`)?.focus();
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={count === null}
              loading={busy}
            >
              Create
            </Button>
          </div>
        </form>
      </Popover>
    </>
  );
}

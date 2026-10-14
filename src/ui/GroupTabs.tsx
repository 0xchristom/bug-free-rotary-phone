import { useId, useState, type SyntheticEvent } from 'react';
import { isGroupName } from '../core/groups.ts';
import {
  GROUP_STATE_LABELS,
  GROUP_STATE_TONES,
  type GroupState,
  type MoveTarget,
} from './group-view.ts';
import { formatSol } from './sol.ts';
import { Button, Chip, IconButton, Input, Popover, cx } from './kit/index.ts';

export interface GroupTab {
  readonly id: string;
  readonly name: string;
  readonly wallets: readonly number[];
  readonly state: GroupState;
  /** Sum of the known SOL balances; null while none is known. */
  readonly lamports: bigint | null;
}

export interface GroupTabsProps {
  readonly groups: readonly GroupTab[];
  /** The shown group, or null for "All". */
  readonly tab: string | null;
  readonly onTab: (id: string | null) => void;
  readonly allCount: number;
  readonly allLamports: bigint | null;
  /** Why the shown group cannot be renamed or deleted now; null = it can. */
  readonly renameBlocked: string | null;
  readonly deleteBlocked: string | null;
  readonly onRename: (name: string) => Promise<boolean>;
  readonly onDelete: () => Promise<boolean>;
}

export interface MoveToGroupProps {
  readonly groups: readonly GroupTab[];
  /** Why the selected wallets cannot move now, or null. */
  readonly moveBlocked: string | null;
  /** How many selected wallets would move. */
  readonly moveCount: number;
  /** Why each group cannot take wallets now (by id), or no entry. */
  readonly targetBlocked: ReadonlyMap<string, string>;
  readonly onMove: (target: MoveTarget) => Promise<boolean>;
}

function sol(lamports: bigint | null): string {
  return lamports === null ? '— SOL' : `${formatSol(lamports)} SOL`;
}

/** A group name: the core rules plus no other group with the same name (any case). */
function nameProblem(text: string, taken: readonly string[]): string | null {
  const name = text.trim();
  if (name === '') return null;
  if (!isGroupName(name)) return 'A group name has 1 to 32 characters.';
  const key = name.toLowerCase();
  return taken.some((t) => t.toLowerCase() === key) ? 'Another group has this name.' : null;
}

function NameForm({
  label,
  submit,
  taken,
  initial = '',
  onSubmit,
  onCancel,
}: {
  readonly label: string;
  readonly submit: string;
  readonly taken: readonly string[];
  readonly initial?: string;
  readonly onSubmit: (name: string) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const ids = useId();
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const problem = nameProblem(text, taken);
  const ready = text.trim() !== '' && problem === null;
  const send = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    try {
      await onSubmit(text.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="pop-form" onSubmit={(e) => void send(e)} noValidate>
      <label htmlFor={`${ids}-name`}>{label}</label>
      <Input
        id={`${ids}-name`}
        autoComplete="off"
        spellCheck={false}
        value={text}
        invalid={problem !== null}
        aria-describedby={`${ids}-help`}
        onChange={(e) => {
          setText(e.target.value);
        }}
      />
      <p className={problem ? 'field-error' : 'hint'} id={`${ids}-help`}>
        {problem ?? '1 to 32 characters.'}
      </p>
      <div className="actions end">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={!ready} loading={busy}>
          {submit}
        </Button>
      </div>
    </form>
  );
}

/**
 * "Move to group" in the filter row, next to Create wallets (BUNNDLY-69, look of BUNNDLY-73):
 * the selected wallets go to a group or to a new one. With one group this is how the second
 * one is made, so it is there even while the group tabs are not.
 */
export function MoveToGroup(p: MoveToGroupProps) {
  const [open, setOpen] = useState<'move' | 'new' | null>(null);
  const names = p.groups.map((g) => g.name);
  const close = (): void => {
    setOpen(null);
  };
  const move = async (target: MoveTarget): Promise<void> => {
    if (await p.onMove(target)) close();
  };
  return (
    <Popover
      open={open !== null}
      onClose={close}
      label="Move to group"
      trigger={
        <Button
          size="sm"
          disabled={p.moveBlocked !== null}
          title={p.moveBlocked ?? undefined}
          aria-description={p.moveBlocked ?? undefined}
          aria-expanded={open !== null}
          onClick={() => {
            setOpen((was) => (was === null ? 'move' : null));
          }}
        >
          Move to group
        </Button>
      }
    >
      {open === 'new' ? (
        <NameForm
          label={`New group for ${String(p.moveCount)} wallets`}
          submit="Create and move"
          taken={names}
          onSubmit={(name) => move({ name })}
          onCancel={close}
        />
      ) : (
        <div className="pop-form">
          <h3>Move {p.moveCount} wallets to</h3>
          {p.groups.map((g) => {
            const blocked = p.targetBlocked.get(g.id) ?? null;
            return (
              <Button
                key={g.id}
                size="sm"
                disabled={blocked !== null}
                title={blocked ?? undefined}
                aria-description={blocked ?? undefined}
                onClick={() => void move({ id: g.id })}
              >
                {g.name}
              </Button>
            );
          })}
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setOpen('new');
            }}
          >
            New group…
          </Button>
        </div>
      )}
    </Popover>
  );
}

type Menu = 'menu' | 'rename' | 'delete' | null;

const MENU_LABELS: Record<Exclude<Menu, null>, string> = {
  menu: 'Group actions',
  rename: 'Rename group',
  delete: 'Delete group',
};

/**
 * Wallet groups over the table (BUNNDLY-69), shown from two groups on (BUNNDLY-73): one tab
 * per group with its wallets, SOL and state from the worker, and "All". The shown group's
 * tab has a menu with Rename and Delete; a running group keeps its name and its wallets
 * until it ends, and the disabled item says so.
 */
export function GroupTabs(p: GroupTabsProps) {
  const [menu, setMenu] = useState<Menu>(null);
  const names = p.groups.map((g) => g.name);
  const close = (): void => {
    setMenu(null);
  };
  return (
    <div className="tabsrow groups-row">
      <div className="tabs" role="group" aria-label="Wallet groups">
        <button
          type="button"
          className={cx('tab', p.tab === null && 'on')}
          aria-pressed={p.tab === null}
          onClick={() => {
            p.onTab(null);
          }}
        >
          All <span className="tab-count">{p.allCount}</span>
          <span className="tab-sol">{sol(p.allLamports)}</span>
        </button>
        {p.groups.map((g) => (
          <span key={g.id} className="tab-with-menu">
            <button
              type="button"
              className={cx('tab', p.tab === g.id && 'on')}
              aria-pressed={p.tab === g.id}
              onClick={() => {
                p.onTab(g.id);
              }}
            >
              {g.name} <span className="tab-count">{g.wallets.length}</span>
              <span className="tab-sol">{sol(g.lamports)}</span>
              <Chip tone={GROUP_STATE_TONES[g.state]} dot={g.state !== 'idle'}>
                {GROUP_STATE_LABELS[g.state]}
              </Chip>
            </button>
            {p.tab === g.id && (
              <Popover
                open={menu !== null}
                onClose={close}
                label={menu === null ? MENU_LABELS.menu : MENU_LABELS[menu]}
                trigger={
                  <IconButton
                    size="tiny"
                    variant="ghost"
                    label={`Group actions: ${g.name}`}
                    icon={<span aria-hidden="true">⋯</span>}
                    aria-expanded={menu !== null}
                    onClick={() => {
                      setMenu((was) => (was === null ? 'menu' : null));
                    }}
                  />
                }
              >
                {menu === 'rename' ? (
                  <NameForm
                    label={`New name for ${g.name}`}
                    submit="Rename"
                    taken={names.filter((n) => n !== g.name)}
                    initial={g.name}
                    onSubmit={async (name) => {
                      if (await p.onRename(name)) close();
                    }}
                    onCancel={close}
                  />
                ) : menu === 'delete' ? (
                  <div className="pop-form">
                    <p>
                      Delete {g.name}? Its {g.wallets.length} wallets go to{' '}
                      {p.groups[0]?.name ?? 'the first group'}.
                    </p>
                    <div className="actions end">
                      <Button size="sm" variant="ghost" onClick={close}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          void p.onDelete().then((ok) => {
                            if (ok) close();
                          });
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="pop-form">
                    <Button
                      size="sm"
                      disabled={p.renameBlocked !== null}
                      title={p.renameBlocked ?? undefined}
                      aria-description={p.renameBlocked ?? undefined}
                      onClick={() => {
                        setMenu('rename');
                      }}
                    >
                      Rename
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={p.deleteBlocked !== null}
                      title={p.deleteBlocked ?? undefined}
                      aria-description={p.deleteBlocked ?? undefined}
                      onClick={() => {
                        setMenu('delete');
                      }}
                    >
                      Delete group
                    </Button>
                  </div>
                )}
              </Popover>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

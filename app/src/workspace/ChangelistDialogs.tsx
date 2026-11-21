import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { InputDialog } from "./InputDialog";

/** Asks for a new changelist's name and whether to make it active. Rejections show in the dialog. */
export function NewChangelistDialog({
  onCreate,
  onClose,
}: {
  onCreate: (name: string, active: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [active, setActive] = useState(false);
  return (
    <InputDialog title="New Changelist" label="Name" confirmLabel="Create" onConfirm={(name) => onCreate(name, active)} onClose={onClose}>
      <label>
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Set active
      </label>
    </InputDialog>
  );
}

type MoveProps = {
  /** Existing changelist names. */
  names: string[];
  /** The changelist the files come from, when they share one. */
  from?: string;
  count: number;
  /** Moves the files to `name`, which is new when `isNew`. Rejections show in the dialog. */
  onMove: (name: string, isNew: boolean) => Promise<void>;
  onClose: () => void;
};

/** Asks which changelist, existing or new, to move files to. */
export function MoveToChangelistDialog({ names, from, count, onMove, onClose }: MoveProps) {
  /** The chosen existing list, or undefined for a new one. */
  const [choice, setChoice] = useState<string | undefined>(names.find((n) => n !== from));
  const [newName, setNewName] = useState("");
  const name = choice ?? newName.trim();
  const blocker =
    choice !== undefined
      ? undefined
      : !name
        ? "Enter a changelist name"
        : names.includes(name)
          ? `Changelist '${name}' already exists`
          : undefined;
  return (
    <ConfirmDialog
      title="Move to Another Changelist"
      confirmLabel="Move"
      focusConfirm={choice !== undefined}
      blocker={blocker}
      onConfirm={() => onMove(name, choice === undefined)}
      onClose={onClose}
    >
      <p>Move {count === 1 ? "1 file" : `${count} files`} to:</p>
      <div className="dialog-list">
        {names.map((n) => (
          <label key={n} className="check-row">
            <input type="radio" name="changelist" checked={choice === n} onChange={() => setChoice(n)} />
            {n}
          </label>
        ))}
        <label className="check-row">
          <input type="radio" name="changelist" checked={choice === undefined} onChange={() => setChoice(undefined)} />
          New changelist:
          <input
            className="grow"
            value={newName}
            autoFocus={choice === undefined}
            onFocus={() => setChoice(undefined)}
            onChange={(e) => setNewName(e.target.value)}
          />
        </label>
      </div>
    </ConfirmDialog>
  );
}

import { useState, type ReactNode } from "react";
import { ConfirmDialog } from "./ConfirmDialog";

type Props = {
  title: string;
  label: string;
  initial?: string;
  confirmLabel: string;
  /** Runs the action with the trimmed text; rejections show in the dialog. */
  onConfirm: (text: string) => Promise<void>;
  onClose: () => void;
  /** Extra options below the field. */
  children?: ReactNode;
};

/** A modal asking for one line of text, such as a branch name. */
export function InputDialog({ title, label, initial = "", confirmLabel, onConfirm, onClose, children }: Props) {
  const [text, setText] = useState(initial);
  return (
    <ConfirmDialog
      title={title}
      confirmLabel={confirmLabel}
      focusConfirm={false}
      blocker={text.trim() ? undefined : `Enter a ${label.toLowerCase()}`}
      onConfirm={() => onConfirm(text.trim())}
      onClose={onClose}
    >
      <label className="field">
        <span>{label}:</span>
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.target.select()} />
      </label>
      {children}
    </ConfirmDialog>
  );
}

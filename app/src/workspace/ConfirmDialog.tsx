import { useState, type ReactNode } from "react";
import "./Dialog.css";

type Props = {
  title: string;
  confirmLabel: string;
  /** Runs the action; the dialog closes when it resolves and shows the error when it rejects. */
  onConfirm: () => Promise<void>;
  onClose: () => void;
  children: ReactNode;
  /** Focuses the confirm button on open; turn off when a child field takes focus. */
  focusConfirm?: boolean;
  /** Why confirming is not possible yet. Disables the confirm button. */
  blocker?: string;
  width?: number;
};

/** A modal asking to confirm an action, with room for options. */
export function ConfirmDialog({ title, confirmLabel, onConfirm, onClose, children, focusConfirm = true, blocker, width = 520 }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function confirm() {
    if (busy || blocker) return;
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
      onKeyDown={(e) => e.key === "Escape" && !busy && onClose()}
    >
      <form
        className="dialog"
        style={{ width }}
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        <div className="dialog-title">{title}</div>
        <div className="dialog-body">
          {children}
          {error && <p className="error-text">{error}</p>}
        </div>
        <div className="dialog-buttons">
          <span className="grow" />
          <button type="button" className="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy || !!blocker} title={blocker} autoFocus={focusConfirm}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

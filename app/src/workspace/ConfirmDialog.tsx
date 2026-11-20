import { useState, type ReactNode } from "react";
import "./Dialog.css";

type Props = {
  title: string;
  confirmLabel: string;
  /** Runs the action; the dialog closes when it resolves and shows the error when it rejects. */
  onConfirm: () => Promise<void>;
  onClose: () => void;
  children: ReactNode;
};

/** A modal asking to confirm an action, with room for options. */
export function ConfirmDialog({ title, confirmLabel, onConfirm, onClose, children }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function confirm() {
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
      <div className="dialog" style={{ width: 520 }}>
        <div className="dialog-title">{title}</div>
        <div className="dialog-body">
          {children}
          {error && <p className="error-text">{error}</p>}
        </div>
        <div className="dialog-buttons">
          <span className="grow" />
          <button className="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy} autoFocus onClick={confirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

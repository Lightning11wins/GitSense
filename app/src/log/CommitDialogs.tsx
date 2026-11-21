import { useEffect, useRef, useState } from "react";
import type { ResetMode } from "../protocol.gen";
import { call } from "../api";
import { ConfirmDialog } from "../workspace/ConfirmDialog";
import type { LogRow } from "./interleave";

const MODES: { mode: ResetMode; label: string; detail: string }[] = [
  { mode: "soft", label: "Soft", detail: "Keeps the changes of later commits staged." },
  { mode: "mixed", label: "Mixed", detail: "Keeps the changes of later commits, unstaged." },
  { mode: "hard", label: "Hard", detail: "Discards the changes of later commits and all local changes." },
  { mode: "keep", label: "Keep", detail: "Discards the changes of later commits, keeping local changes." },
];

/** Asks how to reset the current branch to a commit, then resets. */
export function ResetDialog({ row, branch, onDone, onClose }: { row: LogRow; branch?: string; onDone: () => void; onClose: () => void }) {
  const [mode, setMode] = useState<ResetMode>("mixed");
  return (
    <ConfirmDialog
      title={`Reset ${branch ?? "HEAD"} to ${row.commit.hash.slice(0, 8)}`}
      confirmLabel="Reset"
      onConfirm={async () => {
        await call("reset", { repo: row.repo, rev: row.commit.hash, mode });
        onDone();
      }}
      onClose={onClose}
    >
      {MODES.map((m) => (
        <label key={m.mode}>
          <input type="radio" name="reset-mode" checked={mode === m.mode} onChange={() => setMode(m.mode)} />
          <span>
            {m.label}: <span className="secondary">{m.detail}</span>
          </span>
        </label>
      ))}
    </ConfirmDialog>
  );
}

/** Edits a commit's full message. */
export function RewordDialog({ row, onDone, onClose }: { row: LogRow; onDone: () => void; onClose: () => void }) {
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    call("commit.message", { repo: row.repo, rev: row.commit.hash }).then(setText, (e) => setError(String(e)));
  }, [row.repo, row.commit.hash]);
  const loaded = text !== undefined;
  useEffect(() => {
    if (loaded) field.current?.focus();
  }, [loaded]);
  return (
    <ConfirmDialog
      title={`Edit Message of ${row.commit.hash.slice(0, 8)}`}
      confirmLabel="Save"
      focusConfirm={false}
      blocker={text === undefined ? "Loading the message" : text.trim() ? undefined : "Enter a message"}
      onConfirm={async () => {
        await call("commit.reword", { repo: row.repo, rev: row.commit.hash, message: text! });
        onDone();
      }}
      onClose={onClose}
    >
      {error && <div className="error-text">{error}</div>}
      <textarea
        ref={field}
        className="reword-message"
        value={text ?? ""}
        readOnly={!loaded}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.ctrlKey) e.currentTarget.form?.requestSubmit();
        }}
      />
    </ConfirmDialog>
  );
}

import { useState } from "react";
import { setAutoFetchMinutes, type Settings } from "../api";
import { ConfirmDialog } from "./ConfirmDialog";

/** App settings shared by every window. */
export function SettingsDialog({ settings, onClose }: { settings: Settings; onClose: () => void }) {
  const [autoFetch, setAutoFetch] = useState(settings.auto_fetch_minutes > 0);
  const [minutes, setMinutes] = useState(String(settings.auto_fetch_minutes || 5));
  const valid = /^\d+$/.test(minutes) && Number(minutes) >= 1;
  return (
    <ConfirmDialog
      title="Settings"
      confirmLabel="Save"
      blocker={autoFetch && !valid ? "Enter a whole number of minutes" : undefined}
      onConfirm={() => setAutoFetchMinutes(autoFetch ? Number(minutes) : 0)}
      onClose={onClose}
    >
      <label>
        <input type="checkbox" checked={autoFetch} onChange={(e) => setAutoFetch(e.target.checked)} />
        Fetch all repositories in the background every
        <input
          className="minutes"
          value={minutes}
          disabled={!autoFetch}
          onChange={(e) => setMinutes(e.target.value)}
        />
        minutes
      </label>
    </ConfirmDialog>
  );
}

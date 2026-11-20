import { useEffect, useRef, useState } from "react";
import { Laptop, Loader2, Server } from "lucide-react";
import { lastMachine, listMachines, type Machine } from "./api";
import "./Welcome.css";

type Props = {
  connectingId?: string;
  error?: string;
  onOpen: (machineId: string) => void;
};

/** Machine picker. Reopens the last machine when the window asks for it. */
export function Welcome({ connectingId, error, onOpen }: Props) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [host, setHost] = useState("");
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  useEffect(() => {
    listMachines().then(setMachines);
    // Only the first window of a launch reopens the last machine, and only once.
    const url = new URL(location.href);
    if (url.searchParams.has("autoconnect")) {
      url.searchParams.delete("autoconnect");
      history.replaceState(null, "", url);
      lastMachine().then((id) => id && openRef.current(id));
    }
  }, []);

  const busy = connectingId !== undefined;
  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1>GitSense</h1>
        <p className="secondary">Choose a machine to manage its Git repositories.</p>
        <div className="machine-list">
          {machines.map((m) => (
            <button key={m.id} className="machine" disabled={busy} onClick={() => onOpen(m.id)}>
              {m.host ? <Server size={16} /> : <Laptop size={16} />}
              <span className="machine-label">{m.label}</span>
              {connectingId === m.id && <Loader2 size={16} className="spin" />}
            </button>
          ))}
        </div>
        <form
          className="host-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (host.trim()) onOpen(`ssh:${host.trim()}`);
          }}
        >
          <input placeholder="Other SSH host" value={host} disabled={busy} onChange={(e) => setHost(e.target.value)} />
          <button className="button" disabled={busy || !host.trim()}>
            Connect
          </button>
        </form>
        {connectingId && !machines.some((m) => m.id === connectingId) && (
          <p className="secondary">Connecting to {connectingId.replace(/^ssh:/, "")}...</p>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}

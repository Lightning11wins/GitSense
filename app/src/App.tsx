import { useEffect, useState } from "react";
import { connect, type ConnectedInfo } from "./api";
import { Welcome } from "./Welcome";
import { Workspace } from "./workspace/Workspace";
import { Session } from "./workspace/session";

type State =
  | { kind: "picking"; error?: string }
  | { kind: "connecting"; machineId: string }
  | { kind: "connected"; info: ConnectedInfo; session: Session };

export function App() {
  const [state, setState] = useState<State>({ kind: "picking" });

  async function open(machineId: string) {
    setState({ kind: "connecting", machineId });
    try {
      const info = await connect(machineId);
      setState({ kind: "connected", info, session: new Session(info, () => connect(machineId)) });
    } catch (e) {
      setState({ kind: "picking", error: String(e) });
    }
  }

  useEffect(() => {
    if (state.kind === "connected") {
      state.session.start();
      return () => state.session.dispose();
    }
  }, [state]);

  if (state.kind === "connected") {
    return <Workspace session={state.session} />;
  }
  return (
    <Welcome
      connectingId={state.kind === "connecting" ? state.machineId : undefined}
      error={state.kind === "picking" ? state.error : undefined}
      onOpen={open}
    />
  );
}

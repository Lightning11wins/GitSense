import { useState } from "react";
import { GitBranch, GitCommitHorizontal, SquareTerminal } from "lucide-react";
import { Splitter } from "./Splitter";
import { useSession, type Session } from "./session";
import { CommitPanel } from "./CommitPanel";
import { BottomPanel, type BottomTab } from "./BottomPanel";
import { TopBar } from "./TopBar";
import { StatusBar } from "./StatusBar";
import { CenterTabs } from "./CenterTabs";
import "./Workspace.css";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The main window for a connected machine, laid out like IntelliJ's New UI. */
export function Workspace({ session }: { session: Session }) {
  const [leftOpen, setLeftOpen] = useState(true);
  const [leftWidth, setLeftWidth] = useState(360);
  const [bottomTab, setBottomTab] = useState<BottomTab | null>("log");
  const [bottomHeight, setBottomHeight] = useState(280);
  const disconnected = useSession(session, (s) => s.disconnected);

  const toggleBottom = (tab: BottomTab) => setBottomTab((current) => (current === tab ? null : tab));

  return (
    <div className="workspace">
      <TopBar session={session} />
      <div className="workspace-body">
        <nav className="stripe">
          <button
            className={`icon-button ${leftOpen ? "active" : ""}`}
            title="Commit (Alt+0)"
            onClick={() => setLeftOpen((open) => !open)}
          >
            <GitCommitHorizontal size={18} />
          </button>
          <div className="stripe-spacer" />
          <button
            className={`icon-button ${bottomTab === "log" ? "active" : ""}`}
            title="Git (Alt+9)"
            onClick={() => toggleBottom("log")}
          >
            <GitBranch size={18} />
          </button>
          <button
            className={`icon-button ${bottomTab === "console" ? "active" : ""}`}
            title="Git Console"
            onClick={() => toggleBottom("console")}
          >
            <SquareTerminal size={18} />
          </button>
        </nav>
        <div className="work-area">
          {disconnected && <DisconnectedBanner session={session} reason={disconnected} />}
          <div className="upper">
            {leftOpen && (
              <>
                <div className="tool-window" style={{ width: leftWidth }}>
                  <CommitPanel session={session} />
                </div>
                <Splitter direction="vertical" onResize={(d) => setLeftWidth((w) => clamp(w + d, 220, 900))} />
              </>
            )}
            <div className="center">
              <CenterTabs session={session} />
            </div>
          </div>
          {bottomTab && (
            <>
              <Splitter direction="horizontal" onResize={(d) => setBottomHeight((h) => clamp(h - d, 120, 900))} />
              <div className="tool-window bottom" style={{ height: bottomHeight }}>
                <BottomPanel session={session} tab={bottomTab} onTab={setBottomTab} />
              </div>
            </>
          )}
        </div>
      </div>
      <StatusBar session={session} />
    </div>
  );
}

function DisconnectedBanner({ session, reason }: { session: Session; reason: string }) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function reconnect() {
    setBusy(true);
    setError(undefined);
    try {
      await session.reconnectNow();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="banner error">
      <span className="banner-text">{error ?? reason}</span>
      <button className="button" disabled={busy} onClick={reconnect}>
        {busy ? "Reconnecting..." : "Reconnect"}
      </button>
    </div>
  );
}

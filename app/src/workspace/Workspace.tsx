import { useEffect, useState } from "react";
import { GitBranch, GitCommitHorizontal, SquareTerminal } from "lucide-react";
import { Splitter } from "./Splitter";
import { useSession, type Session } from "./session";
import { CommitPanel } from "./CommitPanel";
import { ShelfPanel } from "./ShelfPanel";
import { BottomPanel, type BottomTab } from "./BottomPanel";
import { TopBar } from "./TopBar";
import { StatusBar } from "./StatusBar";
import { CenterTabs } from "./CenterTabs";
import { OperationBanners } from "../merge/OperationBanner";
import "./Workspace.css";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The main window for a connected machine, laid out like IntelliJ's New UI. */
export function Workspace({ session }: { session: Session }) {
  const [leftOpen, setLeftOpen] = useState(true);
  const [leftTab, setLeftTab] = useState<"commit" | "shelf">("commit");
  const [leftWidth, setLeftWidth] = useState(360);
  const [bottomTab, setBottomTab] = useState<BottomTab | null>("log");
  const [bottomHeight, setBottomHeight] = useState(280);
  const disconnected = useSession(session, (s) => s.disconnected);
  const logFocus = useSession(session, (s) => s.logFocus);

  useEffect(() => {
    if (logFocus) setBottomTab("log");
  }, [logFocus]);

  const toggleBottom = (tab: BottomTab) => setBottomTab((current) => (current === tab ? null : tab));
  const focusCommit = () => {
    setLeftOpen(true);
    setLeftTab("commit");
    session.requestCommitFocus();
  };

  // Global shortcuts from IntelliJ's keymap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (!e.ctrlKey || e.altKey) return;
      if (key === "k" && !e.shiftKey) focusCommit();
      else if (key === "k" && e.shiftKey) session.openPush();
      else if (key === "t" && !e.shiftKey) session.updateProject();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session]);

  return (
    <div className="workspace">
      <TopBar session={session} onCommit={focusCommit} />
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
          <OperationBanners session={session} />
          <div className="upper">
            {leftOpen && (
              <>
                <div className="tool-window" style={{ width: leftWidth }}>
                  <div className="tool-window-tab" hidden={leftTab !== "commit"}>
                    <CommitPanel session={session} tabs={<LeftTabs tab={leftTab} onTab={setLeftTab} />} />
                  </div>
                  <div className="tool-window-tab" hidden={leftTab !== "shelf"}>
                    <ShelfPanel session={session} tabs={<LeftTabs tab={leftTab} onTab={setLeftTab} />} />
                  </div>
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

function LeftTabs({ tab, onTab }: { tab: "commit" | "shelf"; onTab: (tab: "commit" | "shelf") => void }) {
  return (
    <>
      <button className={`tab tool-window-title ${tab === "commit" ? "active" : ""}`} onClick={() => onTab("commit")}>
        Commit
      </button>
      <button className={`tab tool-window-title ${tab === "shelf" ? "active" : ""}`} onClick={() => onTab("shelf")}>
        Shelf
      </button>
    </>
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

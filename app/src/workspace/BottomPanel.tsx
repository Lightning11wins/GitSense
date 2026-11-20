import { Trash2 } from "lucide-react";
import { useSession, type Session } from "./session";
import { repoName } from "./repos";
import "./BottomPanel.css";

export type BottomTab = "log" | "console";

/** The bottom Git tool window, with Log and Console tabs. */
export function BottomPanel({ session, tab, onTab }: { session: Session; tab: BottomTab; onTab: (tab: BottomTab) => void }) {
  return (
    <div className="bottom-panel">
      <div className="tool-window-header">
        <span className="tool-window-title">Git</span>
        <button className={`tab ${tab === "log" ? "active" : ""}`} onClick={() => onTab("log")}>
          Log
        </button>
        <button className={`tab ${tab === "console" ? "active" : ""}`} onClick={() => onTab("console")}>
          Console
        </button>
        <span className="spacer" />
        {tab === "console" && (
          <button className="icon-button" title="Clear" onClick={() => session.clearConsole()}>
            <Trash2 size={16} />
          </button>
        )}
      </div>
      {tab === "console" ? <Console session={session} /> : <div className="center-empty secondary">Log</div>}
    </div>
  );
}

function Console({ session }: { session: Session }) {
  const entries = useSession(session, (s) => s.console);
  const home = useSession(session, (s) => s.info.home);
  const repos = useSession(session, (s) => s.repos);
  return (
    <div className="console mono">
      {entries.length === 0 && <div className="secondary">Git commands that change repositories appear here.</div>}
      {entries.map((entry, i) => {
        const repo = repos.find((r) => r.path === entry.repo);
        return (
          <div key={i} className="console-entry">
            <div className={entry.exit_code === 0 ? "console-command" : "console-command failed"}>
              <span className="secondary">{repo ? repoName(repo, home) : entry.repo}$ </span>
              git {entry.args.join(" ")}
              <span className="secondary">
                {"  "}
                {entry.duration_ms} ms{entry.exit_code !== 0 && `, exit ${entry.exit_code ?? "signal"}`}
              </span>
            </div>
            {entry.output && <pre className="console-output">{entry.output}</pre>}
          </div>
        );
      })}
    </div>
  );
}

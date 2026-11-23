import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDownToLine, Trash2, WrapText } from "lucide-react";
import { useSession, type ConsoleEntry, type Session } from "./session";
import { repoName } from "./repos";
import { LogView } from "../log/LogView";
import "./BottomPanel.css";

export type BottomTab = "log" | "console";

/** The bottom Git tool window, with Log and Console tabs. */
export function BottomPanel({ session, tab, onTab }: { session: Session; tab: BottomTab; onTab: (tab: BottomTab) => void }) {
  const [softWrap, setSoftWrap] = useState(true);
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
      </div>
      {tab === "console" ? <Console session={session} softWrap={softWrap} onSoftWrap={setSoftWrap} /> : <LogView session={session} />}
    </div>
  );
}

function Console({ session, softWrap, onSoftWrap }: { session: Session; softWrap: boolean; onSoftWrap: (on: boolean) => void }) {
  const entries = useSession(session, (s) => s.console);
  const home = useSession(session, (s) => s.info.home);
  const repos = useSession(session, (s) => s.repos);
  const scroller = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const followRef = useRef(follow);
  followRef.current = follow;

  const scrollToEnd = () => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(() => {
    if (follow) scrollToEnd();
  }, [entries, follow, softWrap]);
  useEffect(() => {
    const observer = new ResizeObserver(() => followRef.current && scrollToEnd());
    observer.observe(scroller.current!);
    return () => observer.disconnect();
  }, []);
  const onScroll = () => {
    const el = scroller.current!;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 4);
  };

  return (
    <div className="console">
      <div className="console-toolbar">
        <button className={`icon-button ${softWrap ? "active" : ""}`} title="Soft-Wrap" aria-pressed={softWrap} onClick={() => onSoftWrap(!softWrap)}>
          <WrapText size={16} />
        </button>
        <button className={`icon-button ${follow ? "active" : ""}`} title="Scroll to End" aria-pressed={follow} onClick={() => setFollow(!follow)}>
          <ArrowDownToLine size={16} />
        </button>
        <button className="icon-button" title="Clear" disabled={entries.length === 0} onClick={() => session.clearConsole()}>
          <Trash2 size={16} />
        </button>
      </div>
      <div ref={scroller} className={`console-text mono ${softWrap ? "soft-wrap" : ""}`} onScroll={onScroll}>
        {entries.length === 0 && <div className="console-empty">Git commands that change repositories appear here.</div>}
        {entries.map((entry, i) => {
          const repo = repos.find((r) => r.path === entry.repo);
          return <ConsoleCommand key={i} entry={entry} repoLabel={repo ? repoName(repo, home) : entry.repo} />;
        })}
      </div>
    </div>
  );
}

function ConsoleCommand({ entry, repoLabel }: { entry: ConsoleEntry; repoLabel: string }) {
  const failed = entry.exit_code !== 0;
  return (
    <div className="console-entry">
      <span className="console-time">{formatTime(entry.started)}</span>
      <div className="console-body">
        <div className="console-command">
          <span className="console-repo">{repoLabel}</span>
          <span className={failed ? "console-prompt failed" : "console-prompt"}> $ </span>
          {["git", ...entry.args].map(shellQuote).join(" ")}
          <span className="console-meta">
            {formatDuration(entry.duration_ms)}
            {failed && <span className="console-exit">{entry.exit_code === null ? "killed by a signal" : `exit ${entry.exit_code}`}</span>}
          </span>
        </div>
        {outputLines(entry.output).map((line, i) => (
          <div key={i} className={`console-output ${lineKind(line)}`}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** An argument as a POSIX shell would need it, so a copied command runs as shown. */
function shellQuote(arg: string): string {
  return /^[\w@%+=:,./^-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** Output lines as a terminal shows them: a carriage return overwrites the line, as git's progress meters do. */
function outputLines(output: string): string[] {
  const lines = output.split("\n").map((line) => line.split("\r").filter(Boolean).pop() ?? "");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lineKind(line: string): string {
  if (/^(fatal|error):/.test(line)) return "error";
  if (/^warning:/.test(line)) return "warning";
  if (/^hint:/.test(line)) return "dim";
  return "";
}

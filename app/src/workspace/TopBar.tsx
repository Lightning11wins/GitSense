import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Check, ChevronDown, ChevronRight, FolderGit2, RefreshCw, Server } from "lucide-react";
import { newWindow } from "../api";
import { below, Popup } from "./Popup";
import { RepoManager } from "./RepoManager";
import { BranchesPopup } from "./BranchesPopup";
import { SettingsDialog } from "./SettingsDialog";
import { ApplyPatchDialog } from "./ApplyPatchDialog";
import { useSession, type Session } from "./session";
import { repoName } from "./repos";

type Point = { x: number; y: number };
type Open =
  | { kind: "machine" | "repos"; at: Point }
  | { kind: "branches"; repo: string; at: Point }
  | { kind: "manage" | "settings" | "applyPatch" }
  | null;

export function TopBar({ session, onCommit }: { session: Session; onCommit: () => void }) {
  const info = useSession(session, (s) => s.info);
  const repos = useSession(session, (s) => s.repos);
  const statuses = useSession(session, (s) => s.statuses);
  const settings = useSession(session, (s) => s.settings);
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);
  const visible = repos.filter((r) => !r.hidden);
  const changed = visible.filter((r) => (statuses[r.path]?.status?.changes.length ?? 0) > 0).length;

  return (
    <header className="top-bar">
      <button className="widget" onClick={(e) => setOpen({ kind: "machine", at: below(e.currentTarget) })}>
        <Server size={16} />
        {info.machine.label}
        <ChevronDown size={14} className="secondary" />
      </button>
      <button className="widget" onClick={(e) => setOpen({ kind: "repos", at: below(e.currentTarget) })}>
        <FolderGit2 size={16} />
        {visible.length} repositories
        {changed > 0 && <span className="secondary">· {changed} changed</span>}
        <ChevronDown size={14} className="secondary" />
      </button>
      <div className="spacer" />
      <button className="icon-button" title="Update Project (Ctrl+T)" onClick={() => session.updateProject()}>
        <ArrowDownLeft size={18} className="update-icon" />
      </button>
      <button className="icon-button" title="Commit (Ctrl+K)" onClick={onCommit}>
        <Check size={18} className="commit-icon" />
      </button>
      <button className="icon-button" title="Push (Ctrl+Shift+K)" onClick={() => session.openPush()}>
        <ArrowUpRight size={18} className="commit-icon" />
      </button>

      {open?.kind === "machine" && (
        <Popup at={open.at} onClose={close}>
          <div className="popup-list">
            <button className="popup-item" onClick={() => (close(), newWindow())}>
              Open Another Machine...
            </button>
            <button className="popup-item" onClick={() => setOpen({ kind: "manage" })}>
              Manage Repositories...
            </button>
            <button className="popup-item" onClick={() => (close(), session.loadRepos("repos.scan"))}>
              Rescan Home Directory
            </button>
            <button className="popup-item" onClick={() => setOpen({ kind: "applyPatch" })}>
              Apply Patch from Clipboard...
            </button>
            <button className="popup-item" disabled={!settings} onClick={() => setOpen({ kind: "settings" })}>
              Settings...
            </button>
            <div className="popup-separator" />
            <div className="popup-section">
              Helper {info.helper_version} · git {info.git_version} · {info.home}
            </div>
          </div>
        </Popup>
      )}
      {open?.kind === "repos" && (
        <Popup at={open.at} onClose={close} width={420}>
          <div className="popup-title row">
            Repositories
            <span className="grow" />
            <button className="icon-button" title="Fetch All" onClick={() => (close(), session.fetchAll())}>
              <RefreshCw size={14} />
            </button>
          </div>
          <div className="popup-list">
            {repos.map((repo) => {
              const status = statuses[repo.path]?.status;
              return (
                <div key={repo.path} className="popup-check-row">
                  <input
                    type="checkbox"
                    title={repo.hidden ? "Show this repository" : "Hide this repository"}
                    checked={!repo.hidden}
                    onChange={(e) => session.setHidden(repo.path, !e.target.checked).catch((err) => session.notify(String(err)))}
                  />
                  <button
                    className="popup-item"
                    title={repo.path}
                    disabled={repo.hidden}
                    onClick={(e) => setOpen({ kind: "branches", repo: repo.path, at: { x: e.currentTarget.getBoundingClientRect().left, y: open.at.y } })}
                  >
                    {repoName(repo, info.home)}
                    {!repo.hidden && <span className="hint">{status ? (status.branch ?? "detached HEAD") : ""}</span>}
                    {!repo.hidden && <ChevronRight size={14} className="secondary" />}
                  </button>
                </div>
              );
            })}
          </div>
        </Popup>
      )}
      {open?.kind === "branches" && <BranchesPopup session={session} repo={open.repo} at={open.at} onClose={close} />}
      {open?.kind === "manage" && <RepoManager session={session} onClose={close} />}
      {open?.kind === "applyPatch" && <ApplyPatchDialog session={session} onClose={close} />}
      {open?.kind === "settings" && settings && <SettingsDialog settings={settings} onClose={close} />}
    </header>
  );
}

import { useState } from "react";
import { ChevronDown, FolderGit2, GitBranch, Server } from "lucide-react";
import { newWindow } from "../api";
import { below, Popup } from "./Popup";
import { RepoManager } from "./RepoManager";
import { useSession, type Session } from "./session";
import { repoName } from "./repos";

type Open = { kind: "machine" | "repos"; at: { x: number; y: number } } | { kind: "manage" } | null;

export function TopBar({ session }: { session: Session }) {
  const info = useSession(session, (s) => s.info);
  const repos = useSession(session, (s) => s.repos);
  const statuses = useSession(session, (s) => s.statuses);
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
            <div className="popup-separator" />
            <div className="popup-section">
              Helper {info.helper_version} · git {info.git_version} · {info.home}
            </div>
          </div>
        </Popup>
      )}
      {open?.kind === "repos" && (
        <Popup at={open.at} onClose={close} width={420}>
          <div className="popup-title">Repositories</div>
          <div className="popup-list">
            {visible.map((repo) => {
              const status = statuses[repo.path]?.status;
              return (
                <div key={repo.path} className="popup-item" title={repo.path}>
                  <GitBranch size={14} className="secondary" />
                  {repoName(repo, info.home)}
                  <span className="hint">{status ? (status.branch ?? "detached HEAD") : ""}</span>
                </div>
              );
            })}
          </div>
        </Popup>
      )}
      {open?.kind === "manage" && <RepoManager session={session} onClose={close} />}
    </header>
  );
}

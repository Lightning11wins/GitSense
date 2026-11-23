import { useState } from "react";
import { call } from "../api";
import { useSession, type Session } from "./session";
import { repoName } from "./repos";
import "./Dialog.css";

/** Dialog to show or hide repos, add ones outside home, and rescan. */
export function RepoManager({ session, onClose }: { session: Session; onClose: () => void }) {
  const repos = useSession(session, (s) => s.repos);
  const home = useSession(session, (s) => s.info.home);
  const loading = useSession(session, (s) => s.reposLoading);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string>();

  async function add() {
    setError(undefined);
    try {
      await call("repos.add", { path: path.trim() });
      setPath("");
      await session.loadRepos("repos.list");
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 640 }}>
        <div className="dialog-title">Repositories</div>
        <div className="dialog-body">
          <p className="secondary">Unchecked repositories are hidden everywhere in GitSense.</p>
          <div className="dialog-list">
            {repos.map((repo) => (
              <label key={repo.path} className="check-row" title={repo.path}>
                <input
                  type="checkbox"
                  checked={!repo.hidden}
                  onChange={(e) => session.setHidden(repo.path, !e.target.checked).catch((err) => setError(String(err)))}
                />
                <span>{repoName(repo, home)}</span>
                {repo.is_worktree && <span className="secondary">worktree</span>}
              </label>
            ))}
          </div>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (path.trim()) add();
            }}
          >
            <input className="grow" placeholder="Add a repository by absolute or ~/ path" value={path} onChange={(e) => setPath(e.target.value)} />
            <button className="button" disabled={!path.trim()}>
              Add
            </button>
          </form>
          {error && <p className="error-text">{error}</p>}
        </div>
        <div className="dialog-buttons">
          <button className="button" disabled={loading} onClick={() => session.loadRepos("repos.scan")}>
            {loading ? "Scanning..." : "Rescan Home Directory"}
          </button>
          <span className="grow" />
          <button className="button primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

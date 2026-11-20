import { useEffect, useState } from "react";
import { ArrowRight, FileText, FolderGit2, RefreshCw } from "lucide-react";
import type { CommitInfo, FileChange, LocalBranch } from "../protocol.gen";
import { call } from "../api";
import { useSession, type PushTab, type Session } from "./session";
import { baseName, dirName, repoName } from "./repos";
import "./PushView.css";

type RepoPush = {
  repo: string;
  branch: string;
  remotes: string[];
  remote: string;
  remoteBranch: string;
  /** The branch already has an upstream. */
  tracked: boolean;
  commits?: CommitInfo[];
  error?: string;
  included: boolean;
};

type Selected = { repo: string; hash: string };

/** Push Commits: each repo's outgoing commits and their files, with the push target and options. */
export function PushView({ session, tab }: { session: Session; tab: PushTab }) {
  const repos = useSession(session, (s) => s.repos);
  const home = useSession(session, (s) => s.info.home);
  const [pushes, setPushes] = useState<RepoPush[]>();
  const [loadError, setLoadError] = useState<string>();
  const [selected, setSelected] = useState<Selected>();
  const [files, setFiles] = useState<FileChange[]>();
  const [force, setForce] = useState(false);
  const [setUpstream, setSetUpstream] = useState(true);
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoadError(undefined);
    try {
      const targets = tab.branch
        ? [tab.branch]
        : repos
            .filter((r) => !r.hidden)
            .map((r) => ({ repo: r.path, name: session.getState().statuses[r.path]?.status?.branch }))
            .filter((t): t is { repo: string; name: string } => !!t.name);
      const loaded = await Promise.all(targets.map((t) => loadPush(t.repo, t.name)));
      const list = loaded.filter((p): p is RepoPush => !!p && (!!tab.branch || !!p.error || !!p.commits?.length));
      setPushes(list);
      const first = list.find((p) => p.commits?.length);
      setSelected(first && { repo: first.repo, hash: first.commits![0].hash });
    } catch (e) {
      setLoadError(String(e));
    }
  }

  useEffect(() => {
    load();
    // Reopening the tab bumps its version to reload.
  }, [tab.version]);

  useEffect(() => {
    setFiles(undefined);
    if (!selected) return;
    let stale = false;
    call("commit.files", { repo: selected.repo, rev: selected.hash })
      .then((list) => !stale && setFiles(list))
      .catch((e) => !stale && session.notify(String(e)));
    return () => {
      stale = true;
    };
  }, [selected?.repo, selected?.hash]);

  function patch(repo: string, change: Partial<RepoPush>) {
    setPushes((list) => list?.map((p) => (p.repo === repo ? { ...p, ...change } : p)));
  }

  async function retarget(push: RepoPush, change: Partial<RepoPush>) {
    const next = { ...push, ...change };
    patch(push.repo, { ...change, commits: undefined, error: undefined });
    try {
      patch(push.repo, { commits: await outgoing(next) });
    } catch (e) {
      patch(push.repo, { error: String(e) });
    }
  }

  const toPush = (pushes ?? []).filter((p) => p.included && p.commits && (p.commits.length > 0 || !p.tracked));
  const anyUntracked = toPush.some((p) => !p.tracked);

  async function push() {
    if (busy || toPush.length === 0) return;
    setBusy(true);
    const pushed = new Set<string>();
    let failed = false;
    await session.track(`Pushing ${toPush.length} repositories...`, async () => {
      for (const p of toPush) {
        try {
          await call("push", {
            repo: p.repo,
            branch: p.branch,
            remote: p.remote,
            remote_branch: p.remoteBranch,
            set_upstream: !p.tracked && setUpstream,
            force_with_lease: force,
          });
          p.commits!.forEach((c) => pushed.add(c.hash));
          patch(p.repo, { included: false, commits: [] });
        } catch (e) {
          failed = true;
          patch(p.repo, { error: String(e) });
        }
        session.refreshStatus(p.repo);
      }
    });
    setBusy(false);
    if (pushed.size > 0) session.notify(`Pushed ${pushed.size === 1 ? "1 commit" : `${pushed.size} commits`}.`);
    if (!failed) session.closeTab(tab.id);
  }

  return (
    <div
      className="push-view"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.ctrlKey && e.key === "Enter") {
          e.preventDefault();
          push();
        }
      }}
    >
      <div className="diff-toolbar">
        <span className="push-title">Push Commits</span>
        <span className="spacer" />
        <button className="icon-button" title="Refresh" disabled={busy} onClick={load}>
          <RefreshCw size={16} />
        </button>
      </div>
      <div className="push-body">
        <div className="tree push-commits">
          {loadError && <div className="error-text tree-message">{loadError}</div>}
          {!pushes && !loadError && <div className="secondary tree-message">Loading...</div>}
          {pushes?.length === 0 && <div className="secondary tree-message">No commits to push</div>}
          {pushes?.map((p) => (
            <div key={p.repo}>
              <div className="tree-row push-target">
                <input
                  type="checkbox"
                  checked={p.included}
                  disabled={busy}
                  onChange={(e) => patch(p.repo, { included: e.target.checked })}
                />
                <FolderGit2 size={14} className="secondary" />
                <span title={p.repo}>{repoName({ path: p.repo }, home)}</span>
                <span className="secondary">{p.branch}</span>
                <ArrowRight size={14} className="secondary" />
                {p.remotes.length > 1 ? (
                  <select value={p.remote} disabled={busy} onChange={(e) => retarget(p, { remote: e.target.value })}>
                    {p.remotes.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                ) : (
                  <span>{p.remote}</span>
                )}
                <span className="secondary">:</span>
                <BranchInput value={p.remoteBranch} disabled={busy} onCommit={(name) => retarget(p, { remoteBranch: name })} />
                {!p.tracked && <span className="push-new">New</span>}
              </div>
              {p.error && <div className="error-text push-error">{p.error}</div>}
              {p.commits?.length === 0 && !p.error && <div className="secondary push-error">Nothing to push</div>}
              {p.commits?.map((c) => (
                <div
                  key={c.hash}
                  className={`tree-row push-commit ${selected?.repo === p.repo && selected.hash === c.hash ? "selected" : ""}`}
                  onMouseDown={() => setSelected({ repo: p.repo, hash: c.hash })}
                >
                  <span className="push-subject">{c.subject}</span>
                  <span className="secondary">{c.author_name}</span>
                  <span className="secondary">{new Date(c.author_time * 1000).toLocaleString()}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="tree push-files">
          {selected && !files && <div className="secondary tree-message">Loading...</div>}
          {files?.map((f) => (
            <div
              key={f.path}
              className="tree-row"
              title={f.orig_path ? `Renamed from ${f.orig_path}` : f.path}
              onDoubleClick={() => selected && session.openCommitDiff(selected.repo, selected.hash, f)}
            >
              <FileText size={14} className="secondary" />
              <span className={`status-${f.kind}`}>{baseName(f.path)}</span>
              <span className="secondary">{dirName(f.path)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="push-options">
        <label className="amend">
          <input type="checkbox" checked={force} disabled={busy} onChange={(e) => setForce(e.target.checked)} /> Force push
          (with lease)
        </label>
        {anyUntracked && (
          <label className="amend">
            <input type="checkbox" checked={setUpstream} disabled={busy} onChange={(e) => setSetUpstream(e.target.checked)} />{" "}
            Set upstream for new branches
          </label>
        )}
        <span className="grow" />
        <button className="button" disabled={busy} onClick={() => session.closeTab(tab.id)}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={busy || toPush.length === 0}
          title={toPush.length === 0 ? "Select commits to push" : "Push (Ctrl+Enter)"}
          onClick={push}
        >
          {busy ? "Pushing..." : force ? "Force Push" : "Push"}
        </button>
      </div>
    </div>
  );
}

/** A remote branch name field that applies its value on Enter or blur. */
function BranchInput({ value, disabled, onCommit }: { value: string; disabled: boolean; onCommit: (name: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => text.trim() && text.trim() !== value && onCommit(text.trim());
  return (
    <input
      className="push-branch"
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && !e.ctrlKey && commit()}
    />
  );
}

/** Loads a branch's push target and outgoing commits, or null when the repo has no remotes. */
async function loadPush(repo: string, name: string): Promise<RepoPush | null> {
  const [branches, remotes] = await Promise.all([call("branches.list", { repo }), call("remotes.list", { repo })]);
  const branch = branches.local.find((b) => b.name === name);
  if (!branch || remotes.length === 0) return null;
  const push: RepoPush = { repo, branch: name, remotes, ...target(branch, remotes), included: true };
  try {
    return { ...push, commits: await outgoing(push) };
  } catch (e) {
    return { ...push, error: String(e) };
  }
}

/** The branch's upstream, or a same-named branch on `origin` (or the first remote). */
function target(branch: LocalBranch, remotes: string[]) {
  const upstream = branch.upstream;
  // Remote names may contain slashes, so match the longest.
  const remote = upstream && remotes.filter((r) => upstream.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
  if (upstream && remote) return { remote, remoteBranch: upstream.slice(remote.length + 1), tracked: true };
  return { remote: remotes.includes("origin") ? "origin" : remotes[0], remoteBranch: branch.name, tracked: false };
}

function outgoing(p: RepoPush) {
  return call("push.outgoing", { repo: p.repo, branch: p.branch, remote: p.remote, remote_branch: p.remoteBranch });
}

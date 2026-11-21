import { useEffect, useState, type MouseEvent } from "react";
import { FileText } from "lucide-react";
import type { Conflict, ConflictSide, Operation } from "../protocol.gen";
import { call } from "../api";
import { useSession, type Session } from "../workspace/session";
import { baseName, dirName, repoName } from "../workspace/repos";
import "../workspace/Dialog.css";
import "./MergeTool.css";

const NAMES: Record<Operation, string> = { merge: "Merge", rebase: "Rebase", cherry_pick: "Cherry-pick", revert: "Revert" };

/** A banner per repo with a merge, rebase, cherry-pick, or revert in progress. */
export function OperationBanners({ session }: { session: Session }) {
  const repos = useSession(session, (s) => s.repos);
  const statuses = useSession(session, (s) => s.statuses);
  return repos
    .filter((r) => !r.hidden && statuses[r.path]?.status?.operation)
    .map((r) => <OperationBanner key={r.path} session={session} repo={r.path} />);
}

function OperationBanner({ session, repo }: { session: Session; repo: string }) {
  const home = useSession(session, (s) => s.info.home);
  const status = useSession(session, (s) => s.statuses[repo]?.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [showConflicts, setShowConflicts] = useState(false);
  if (!status?.operation) return null;
  const operation = status.operation;
  const conflicts = status.changes.filter((c) => c.kind === "conflicted").length;

  async function run(method: "operation.continue" | "operation.abort" | "operation.skip") {
    setBusy(true);
    setError(undefined);
    try {
      await call(method, { repo });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      session.refreshStatus(repo);
    }
  }

  return (
    <div className="banner info">
      <span className="banner-text">
        {error ?? `${NAMES[operation]} in progress in ${repoName({ path: repo }, home)}${conflicts ? `, ${conflicts} conflicted` : ""}.`}
      </span>
      {conflicts > 0 && (
        <button className="button" onClick={() => setShowConflicts(true)}>
          Resolve Conflicts...
        </button>
      )}
      <button
        className="button"
        disabled={busy || conflicts > 0}
        title={conflicts > 0 ? "Resolve the conflicts first" : undefined}
        onClick={() => run("operation.continue")}
      >
        Continue
      </button>
      {operation !== "merge" && (
        <button className="button" disabled={busy} title="Skip the current commit" onClick={() => run("operation.skip")}>
          Skip
        </button>
      )}
      <button className="button" disabled={busy} onClick={() => run("operation.abort")}>
        Abort
      </button>
      {showConflicts && <ConflictsDialog session={session} repo={repo} onClose={() => setShowConflicts(false)} />}
    </div>
  );
}

/** Conflicted files of a repo, resolved by taking a side or in the merge tool. */
export function ConflictsDialog({ session, repo, onClose }: { session: Session; repo: string; onClose: () => void }) {
  const home = useSession(session, (s) => s.info.home);
  const status = useSession(session, (s) => s.statuses[repo]?.status);
  const [conflicts, setConflicts] = useState<Conflict[]>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stale = false;
    call("conflicts.list", { repo })
      .then((list) => {
        if (stale) return;
        setConflicts(list);
        setSelected((old) => {
          const kept = new Set(list.filter((c) => old.has(c.path)).map((c) => c.path));
          return kept.size || list.length === 0 ? kept : new Set([list[0].path]);
        });
      })
      .catch((e) => !stale && setError(String(e)));
    return () => {
      stale = true;
    };
  }, [repo, status]);

  useEffect(() => {
    if (conflicts?.length === 0) onClose();
  }, [conflicts]);

  const chosen = conflicts?.filter((c) => selected.has(c.path)) ?? [];
  const single = chosen.length === 1 ? chosen[0] : undefined;
  const mergeBlocker = !single
    ? "Select one file"
    : !single.ours || !single.theirs
      ? "One side deleted the file. Accept a side instead."
      : undefined;

  async function accept(side: ConflictSide) {
    setBusy(true);
    setError(undefined);
    try {
      await call("conflict.accept", { repo, paths: chosen.map((c) => c.path), side });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      session.refreshStatus(repo);
    }
  }

  function merge(conflict: Conflict) {
    session.openMerge(repo, conflict.path);
    onClose();
  }

  function click(e: MouseEvent, path: string) {
    if (e.ctrlKey) {
      const next = new Set(selected);
      if (!next.delete(path)) next.add(path);
      setSelected(next);
    } else setSelected(new Set([path]));
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="dialog" style={{ width: 640 }}>
        <div className="dialog-title">Conflicts in {repoName({ path: repo }, home)}</div>
        <div className="dialog-body">
          <div className="dialog-list tree conflicts-list" tabIndex={-1}>
            <div className="tree-row secondary conflicts-header">
              <span className="grow">Name</span>
              <span className="conflict-side">Yours</span>
              <span className="conflict-side">Theirs</span>
            </div>
            {conflicts === undefined && !error && <div className="secondary tree-message">Loading...</div>}
            {conflicts?.map((c) => (
              <div
                key={c.path}
                className={`tree-row ${selected.has(c.path) ? "selected" : ""}`}
                onMouseDown={(e) => click(e, c.path)}
                onDoubleClick={() => c.ours && c.theirs && merge(c)}
              >
                <FileText size={14} className="secondary" />
                <span className="status-conflicted">{baseName(c.path)}</span>
                <span className="secondary grow">{dirName(c.path)}</span>
                <span className="conflict-side">{sideState(c, c.ours)}</span>
                <span className="conflict-side">{sideState(c, c.theirs)}</span>
              </div>
            ))}
          </div>
          {error && <p className="error-text">{error}</p>}
        </div>
        <div className="dialog-buttons">
          <button className="button" disabled={busy || chosen.length === 0} onClick={() => accept("ours")}>
            Accept Yours
          </button>
          <button className="button" disabled={busy || chosen.length === 0} onClick={() => accept("theirs")}>
            Accept Theirs
          </button>
          <button className="button primary" disabled={busy || !!mergeBlocker} title={mergeBlocker} onClick={() => merge(single!)}>
            Merge...
          </button>
          <span className="grow" />
          <button className="button" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function sideState(conflict: Conflict, exists: boolean) {
  return !exists ? "Deleted" : conflict.base ? "Modified" : "Added";
}

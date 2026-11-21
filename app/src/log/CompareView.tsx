import { useEffect, useState, type MouseEvent } from "react";
import { ArrowLeftRight, FileText } from "lucide-react";
import type { CommitInfo, FileChange } from "../protocol.gen";
import { call } from "../api";
import { useSession, type Session } from "../workspace/session";
import { baseName, dirName } from "../workspace/repos";
import { Menu, type Point } from "../workspace/Popup";
import { Splitter } from "../workspace/Splitter";
import { CommitDetails } from "./CommitDetails";
import { formatTime } from "./LogView";
import type { LogRow } from "./interleave";
import "./LogView.css";

/** Compares a branch with another, or with the working tree when `head` is null. */
export type CompareTab = { kind: "compare"; id: string; repo: string; base: string; head: string | null };

export function CompareView({ session, tab }: { session: Session; tab: CompareTab }) {
  return tab.head === null ? <WorkingTreeFiles session={session} tab={tab} base={tab.base} /> : <Branches session={session} tab={tab} head={tab.head} />;
}

type Loaded<T> = { value?: T; error?: string };

/** Commits in one branch and not the other, with swap, and the files the branch changed since the merge base. */
function Branches({ session, tab, head: initialHead }: { session: Session; tab: CompareTab; head: string }) {
  const status = useSession(session, (s) => s.statuses[tab.repo]?.status);
  const [swapped, setSwapped] = useState(false);
  const [base, head] = swapped ? [initialHead, tab.base] : [tab.base, initialHead];
  const [commits, setCommits] = useState<Loaded<CommitInfo[]>>({});
  const [files, setFiles] = useState<Loaded<{ mergeBase: string; files: FileChange[] }>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState(0);
  const [menu, setMenu] = useState<Point>();
  const [detailsWidth, setDetailsWidth] = useState(420);

  useEffect(() => {
    let stale = false;
    setSelected([]);
    call("compare.commits", { repo: tab.repo, base, head }).then(
      (value) => !stale && setCommits({ value }),
      (e) => !stale && setCommits({ error: String(e) }),
    );
    call("compare.files", { repo: tab.repo, base, head }).then(
      (value) => !stale && setFiles({ value: { mergeBase: value.merge_base, files: value.files } }),
      (e) => !stale && setFiles({ error: String(e) }),
    );
    return () => {
      stale = true;
    };
  }, [tab.repo, base, head, status?.head]);

  const list = commits.value ?? [];
  const rows: LogRow[] = list.map((c) => ({ repo: tab.repo, commit: { ...c, commit_time: c.author_time, head: false, refs: [] } }));
  const selectedRows = rows.filter((r) => selected.includes(r.commit.hash));

  function click(e: MouseEvent, index: number) {
    const hash = list[index].hash;
    if (e.shiftKey) {
      const [from, to] = [Math.min(anchor, index), Math.max(anchor, index)];
      setSelected(list.slice(from, to + 1).map((c) => c.hash));
      return;
    }
    setAnchor(index);
    if (e.ctrlKey) setSelected((s) => (s.includes(hash) ? s.filter((h) => h !== hash) : [...s, hash]));
    else setSelected([hash]);
  }

  function cherryPick() {
    const revs = selectedRows.map((r) => r.commit.hash).reverse();
    session
      .track("Cherry-picking...", () => call("cherry_pick", { repo: tab.repo, revs }))
      .catch((e) => session.notify(String(e)))
      .finally(() => session.refreshStatus(tab.repo));
  }

  const cherryPickBlocker =
    status?.branch !== base
      ? `Only commits missing from the current branch can be cherry-picked here`
      : status.operation
        ? `A ${status.operation.replace("_", "-")} is in progress`
        : selectedRows.some((r) => r.commit.parents.length > 1)
          ? "Merge commits can't be applied here"
          : undefined;

  return (
    <div className="log-view">
      <div className="log-toolbar">
        <span>
          Commits in <b>{head}</b> that are not in <b>{base}</b>
        </span>
        <button className="icon-button" title="Swap Branches" onClick={() => setSwapped((s) => !s)}>
          <ArrowLeftRight size={16} />
        </button>
      </div>
      <div className="log-body">
        <div className="tree log-list compare-list" tabIndex={0}>
          {commits.error && <div className="error-text tree-message">{commits.error}</div>}
          {!commits.value && !commits.error && <div className="secondary tree-message">Loading...</div>}
          {commits.value?.length === 0 && <div className="secondary tree-message">No commits</div>}
          {list.map((c, index) => (
            <div
              key={c.hash}
              className={`tree-row compare-row ${selected.includes(c.hash) ? "selected" : ""}`}
              onMouseDown={(e) => e.button === 0 && click(e, index)}
              onContextMenu={(e) => {
                e.preventDefault();
                if (!selected.includes(c.hash)) {
                  setAnchor(index);
                  setSelected([c.hash]);
                }
                setMenu({ x: e.clientX, y: e.clientY });
              }}
            >
              <span className="log-subject">{c.subject}</span>
              <span className="log-author secondary">{c.author_name}</span>
              <span className="log-date secondary">{formatTime(c.author_time)}</span>
              <span className="log-hash secondary mono">{c.hash.slice(0, 8)}</span>
            </div>
          ))}
        </div>
        <Splitter direction="vertical" onResize={(d) => setDetailsWidth((w) => Math.max(200, Math.min(900, w - d)))} />
        <div className="log-details" style={{ width: detailsWidth }}>
          {selectedRows.length > 0 ? (
            <CommitDetails session={session} rows={selectedRows} multiRepo={false} />
          ) : (
            <FileList
              title={`Changes in ${head} since the merge base`}
              files={files.value?.files}
              error={files.error}
              onOpen={(f) => session.openRevDiff(tab.repo, files.value!.mergeBase, head, f)}
            />
          )}
        </div>
      </div>
      {menu && (
        <Menu
          at={menu}
          onClose={() => setMenu(undefined)}
          actions={[{ label: "Cherry-Pick", disabled: cherryPickBlocker, run: cherryPick }]}
        />
      )}
    </div>
  );
}

/** Files that differ between a branch and the working tree. */
function WorkingTreeFiles({ session, tab, base }: { session: Session; tab: CompareTab; base: string }) {
  const status = useSession(session, (s) => s.statuses[tab.repo]?.status);
  const [files, setFiles] = useState<Loaded<FileChange[]>>({});
  useEffect(() => {
    let stale = false;
    call("diff.files", { repo: tab.repo, from: base, to: null }).then(
      (value) => !stale && setFiles({ value }),
      (e) => !stale && setFiles({ error: String(e) }),
    );
    return () => {
      stale = true;
    };
  }, [tab.repo, base, status]);
  return (
    <div className="log-view">
      <FileList
        title={`Files that differ between ${base} and the working tree`}
        files={files.value}
        error={files.error}
        onOpen={(f) => session.openDiff(tab.repo, f, base)}
      />
    </div>
  );
}

function FileList({ title, files, error, onOpen }: { title: string; files?: FileChange[]; error?: string; onOpen: (f: FileChange) => void }) {
  return (
    <div className="tree commit-files" tabIndex={-1}>
      <div className="tree-row commit-range secondary">{title}</div>
      {error && <div className="error-text tree-message">{error}</div>}
      {!files && !error && <div className="secondary tree-message">Loading...</div>}
      {files?.length === 0 && <div className="secondary tree-message">No differences</div>}
      {files?.map((f) => (
        <div key={f.path} className="tree-row" title={f.orig_path ? `Renamed from ${f.orig_path}` : f.path} onDoubleClick={() => onOpen(f)}>
          <FileText size={14} className="secondary" />
          <span className={`status-${f.kind}`}>{baseName(f.path)}</span>
          <span className="secondary">{dirName(f.path)}</span>
        </div>
      ))}
    </div>
  );
}

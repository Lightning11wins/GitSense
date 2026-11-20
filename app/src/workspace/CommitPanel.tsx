import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileText, FolderGit2, History, RefreshCw } from "lucide-react";
import type { FileChange, IgnoreFile, Repo } from "../protocol.gen";
import { call } from "../api";
import { useSession, type Session } from "./session";
import { baseName, dirName, repoName } from "./repos";
import { Popup } from "./Popup";
import { ConfirmDialog } from "./ConfirmDialog";
import { recentMessages, rememberMessage } from "./commitHistory";
import "./CommitPanel.css";

type Section = "changes" | "unversioned";
type FileNode = { key: string; section: Section; repo: Repo; file: FileChange };
type TreeRow = {
  key: string;
  depth: number;
  /** Whether the node is expanded; undefined for files. */
  open?: boolean;
  files: FileNode[];
  content: React.ReactNode;
};
type Menu = { at: { x: number; y: number }; nodes: FileNode[]; ignoreTargets?: IgnoreFile[] };
type Dialog = { kind: "rollback"; nodes: FileNode[]; deleteAdded: boolean } | { kind: "delete"; nodes: FileNode[] };

/** The Commit tool window: changes grouped by repo, inclusion checkboxes, and the commit message. */
export function CommitPanel({ session }: { session: Session }) {
  const repos = useSession(session, (s) => s.repos);
  const statuses = useSession(session, (s) => s.statuses);
  const home = useSession(session, (s) => s.info.home);
  const reposError = useSession(session, (s) => s.reposError);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string>();
  /** Tracked changes are included unless excluded; unversioned files only when included. */
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [includedUnversioned, setIncludedUnversioned] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [beforeAmend, setBeforeAmend] = useState<{ message: string; loaded: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [menu, setMenu] = useState<Menu>();
  const [historyAt, setHistoryAt] = useState<{ x: number; y: number }>();
  const [dialog, setDialog] = useState<Dialog>();
  const messageRef = useRef<HTMLTextAreaElement>(null);

  // Tree data: sections, then repos, then files.
  const sections: Record<Section, { repo: Repo; branch: string | null; files: FileNode[] }[]> = {
    changes: [],
    unversioned: [],
  };
  const errors: { repo: Repo; error: string }[] = [];
  for (const repo of repos) {
    if (repo.hidden) continue;
    const entry = statuses[repo.path];
    if (entry?.error) errors.push({ repo, error: entry.error });
    const status = entry?.status;
    if (!status) continue;
    for (const section of ["changes", "unversioned"] as const) {
      const files = status.changes
        .filter((c) => (c.kind === "untracked") === (section === "unversioned"))
        .map((file) => ({ key: `${section}\0${repo.path}\0${file.path}`, section, repo, file }));
      if (files.length) sections[section].push({ repo, branch: status.branch, files });
    }
  }
  const allFiles = [...sections.changes, ...sections.unversioned].flatMap((g) => g.files);

  const isIncluded = (node: FileNode) =>
    node.section === "changes" ? !excluded.has(node.key) : includedUnversioned.has(node.key);
  const included = allFiles.filter(isIncluded);

  function setIncluded(nodes: FileNode[], value: boolean) {
    const update = (set: Set<string>, section: Section, add: boolean) => {
      const next = new Set(set);
      for (const node of nodes) if (node.section === section) add ? next.add(node.key) : next.delete(node.key);
      return next;
    };
    setExcluded((set) => update(set, "changes", !value));
    setIncludedUnversioned((set) => update(set, "unversioned", value));
  }

  // Visible rows, in order.
  const rows: TreeRow[] = [];
  for (const [section, title] of [
    ["changes", "Changes"],
    ["unversioned", "Unversioned Files"],
  ] as const) {
    const groups = sections[section];
    const files = groups.flatMap((g) => g.files);
    if (files.length === 0) continue;
    const open = !collapsed.has(section);
    rows.push({
      key: section,
      depth: 0,
      open,
      files,
      content: (
        <>
          <span className="label section-label">{title}</span>
          <span className="hint">{files.length === 1 ? "1 file" : `${files.length} files`}</span>
        </>
      ),
    });
    if (!open) continue;
    for (const group of groups) {
      const groupKey = `${section}\0${group.repo.path}`;
      const groupOpen = !collapsed.has(groupKey);
      rows.push({
        key: groupKey,
        depth: 1,
        open: groupOpen,
        files: group.files,
        content: (
          <>
            <FolderGit2 size={14} className="secondary" />
            <span className="label">{repoName(group.repo, home)}</span>
            <span className="hint">{group.branch ?? "detached HEAD"}</span>
          </>
        ),
      });
      if (!groupOpen) continue;
      for (const node of group.files) {
        const { file } = node;
        rows.push({
          key: node.key,
          depth: 2,
          files: [node],
          content: (
            <>
              <FileText size={14} className="secondary" />
              <span className={`label status-${file.kind}`} title={file.orig_path ? `Renamed from ${file.orig_path}` : undefined}>
                {baseName(file.path)}
              </span>
              <span className="hint">{dirName(file.path)}</span>
            </>
          ),
        });
      }
    }
  }

  const filesOf = (keys: Set<string>) => uniqueFiles(rows.filter((r) => keys.has(r.key)).flatMap((r) => r.files));
  const selectedFiles = filesOf(selected);
  const tracked = selectedFiles.filter((n) => n.section === "changes");
  const unversioned = selectedFiles.filter((n) => n.section === "unversioned");

  function toggle(key: string) {
    setCollapsed((old) => {
      const next = new Set(old);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  function select(key: string, e: { ctrlKey: boolean; shiftKey: boolean }) {
    if (e.shiftKey && anchor) {
      const a = rows.findIndex((r) => r.key === anchor);
      const b = rows.findIndex((r) => r.key === key);
      if (a >= 0 && b >= 0) {
        setSelected(new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.key)));
        return;
      }
    }
    if (e.ctrlKey) {
      setSelected((old) => {
        const next = new Set(old);
        if (!next.delete(key)) next.add(key);
        return next;
      });
    } else {
      setSelected(new Set([key]));
    }
    setAnchor(key);
  }

  /** Runs an action per repo, then refreshes the repos it touched. Rejects with every repo's failure. */
  async function run(nodes: FileNode[], action: (repo: string, nodes: FileNode[]) => Promise<unknown>) {
    setError(undefined);
    const failures: string[] = [];
    for (const [repo, group] of byRepo(nodes)) {
      try {
        await action(repo, group);
      } catch (e) {
        failures.push(String(e));
      }
      session.refreshStatus(repo);
    }
    if (failures.length) throw new Error(failures.join("\n"));
  }

  const showDiff = (nodes: FileNode[]) => nodes[0] && session.openDiff(nodes[0].repo.path, nodes[0].file);
  const reportErrors = (promise: Promise<void>) => promise.catch((e) => setError(String(e)));
  const addToVcs = (nodes: FileNode[]) =>
    reportErrors(run(nodes, (repo, group) => call("files.add", { repo, paths: group.map((n) => n.file.path) })));
  const ignore = (nodes: FileNode[], file: IgnoreFile) =>
    reportErrors(run(nodes, (repo, group) => call("ignore.add", { repo, file, paths: group.map((n) => n.file.path) })));
  const rollback = (nodes: FileNode[], deleteAdded: boolean) =>
    run(nodes, (repo, group) => call("rollback", { repo, paths: withOrigPaths(group), delete_added: deleteAdded }));
  const deleteFiles = (nodes: FileNode[]) =>
    run(nodes, (repo, group) => call("files.delete", { repo, paths: group.map((n) => n.file.path) }));

  async function openMenu(e: React.MouseEvent, key: string) {
    e.preventDefault();
    let keys = selected;
    if (!selected.has(key)) {
      keys = new Set([key]);
      setSelected(keys);
      setAnchor(key);
    }
    const nodes = filesOf(keys);
    const at = { x: e.clientX, y: e.clientY };
    setMenu({ at, nodes });
    const others = nodes.filter((n) => n.section === "unversioned");
    if (others.length && new Set(others.map((n) => n.repo.path)).size === 1) {
      try {
        const targets = await call("ignore.targets", { repo: others[0].repo.path, paths: others.map((n) => n.file.path) });
        setMenu((m) => (m?.at === at ? { ...m, ignoreTargets: targets } : m));
      } catch (err) {
        setError(String(err));
      }
    }
  }

  function onTreeKey(e: React.KeyboardEvent) {
    const index = rows.findIndex((r) => r.key === anchor);
    const row = rows[index];
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const next = rows[Math.max(0, Math.min(rows.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) select(next.key, { ctrlKey: false, shiftKey: e.shiftKey });
    } else if ((e.key === "ArrowRight" && row?.open === false) || (e.key === "ArrowLeft" && row?.open)) {
      toggle(row.key);
    } else if (e.key === " " && selectedFiles.length) {
      setIncluded(selectedFiles, !selectedFiles.every(isIncluded));
    } else if (e.key === "Enter" || (ctrl && !e.altKey && key === "d")) {
      showDiff(selectedFiles);
    } else if (ctrl && e.altKey && key === "z" && tracked.length) {
      setDialog({ kind: "rollback", nodes: tracked, deleteAdded: false });
    } else if (ctrl && e.altKey && key === "a" && unversioned.length) {
      addToVcs(unversioned);
    } else if (e.key === "Delete" && unversioned.length) {
      setDialog({ kind: "delete", nodes: unversioned });
    } else {
      return;
    }
    e.preventDefault();
  }

  // Ctrl+K focuses the commit message, as in IntelliJ.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        messageRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function toggleAmend(value: boolean) {
    setAmend(value);
    if (!value) {
      // Unchecking restores the message from before amending, unless the user edited the loaded one.
      if (beforeAmend && message === beforeAmend.loaded) setMessage(beforeAmend.message);
      setBeforeAmend(undefined);
      return;
    }
    const repoPaths = [...byRepo(included).keys()];
    if (message.trim() || repoPaths.length === 0) return;
    try {
      const messages = await Promise.all(repoPaths.map((repo) => call("commit.message", { repo, rev: "HEAD" })));
      if (messages.every((m) => m === messages[0])) {
        setBeforeAmend({ message, loaded: messages[0] });
        setMessage(messages[0]);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  const commitBlocker =
    included.length === 0
      ? "Select changes to commit"
      : !message.trim()
        ? "Enter a commit message"
        : busy
          ? "Committing..."
          : undefined;

  async function commit() {
    if (commitBlocker) return;
    setBusy(true);
    let count = 0;
    try {
      await run(included, async (repo, group) => {
        await call("commit", { repo, paths: withOrigPaths(group), message, amend });
        count += group.length;
      });
      rememberMessage(message);
      setMessage("");
      setAmend(false);
      setBeforeAmend(undefined);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      if (count) session.notify(`${count === 1 ? "1 file" : `${count} files`} committed: ${message.split("\n")[0]}`);
    }
  }

  const history = historyAt ? recentMessages() : [];
  return (
    <div className="commit-panel">
      <div className="tool-window-header">
        <span className="tool-window-title">Commit</span>
        <span className="spacer" />
        <button className="icon-button" title="Refresh" onClick={session.refreshAll}>
          <RefreshCw size={16} />
        </button>
      </div>
      <div className="tree changes-tree" tabIndex={0} onKeyDown={onTreeKey}>
        {reposError && <div className="error-text tree-message">{reposError}</div>}
        {errors.map(({ repo, error }) => (
          <div key={repo.path} className="error-text tree-message">
            {error}
          </div>
        ))}
        {rows.map((row) => {
          const state = inclusion(row.files, isIncluded);
          return (
            <div
              key={row.key}
              className={`tree-row ${selected.has(row.key) ? "selected" : ""}`}
              style={{ paddingLeft: 4 + row.depth * 16 }}
              onMouseDown={(e) => e.button === 0 && select(row.key, e)}
              onDoubleClick={() => (row.open === undefined ? showDiff(row.files) : toggle(row.key))}
              onContextMenu={(e) => openMenu(e, row.key)}
            >
              <span
                className="chevron"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  if (row.open !== undefined) toggle(row.key);
                }}
              >
                {row.open === undefined ? null : row.open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </span>
              <input
                type="checkbox"
                className="include"
                checked={state === "all"}
                ref={(el) => {
                  if (el) el.indeterminate = state === "some";
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onChange={() => setIncluded(row.files, state !== "all")}
              />
              {row.content}
            </div>
          );
        })}
        {allFiles.length === 0 && !reposError && <div className="secondary tree-message">No changes</div>}
      </div>
      <div className="commit-message">
        <div className="commit-options">
          <label className="amend">
            <input type="checkbox" checked={amend} onChange={(e) => toggleAmend(e.target.checked)} /> Amend
          </label>
          <span className="grow" />
          <button
            className="icon-button"
            title="Commit Message History"
            onClick={(e) => setHistoryAt({ x: e.clientX, y: e.clientY })}
          >
            <History size={16} />
          </button>
        </div>
        <textarea
          ref={messageRef}
          placeholder="Commit Message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
        />
        {error && <div className="error-text commit-error">{error}</div>}
        <div className="commit-buttons">
          <button className="button primary" disabled={!!commitBlocker} title={commitBlocker} onClick={commit}>
            {amend ? "Amend Commit" : "Commit"}
          </button>
          <button className="button" disabled title="Not available yet">
            Commit and Push...
          </button>
        </div>
      </div>
      {menu && (
        <ChangesMenu
          menu={menu}
          onClose={() => setMenu(undefined)}
          onShowDiff={() => showDiff(menu.nodes)}
          onRollback={() =>
            setDialog({ kind: "rollback", nodes: menu.nodes.filter((n) => n.section === "changes"), deleteAdded: false })
          }
          onAdd={() => addToVcs(menu.nodes.filter((n) => n.section === "unversioned"))}
          onIgnore={(file) => ignore(menu.nodes.filter((n) => n.section === "unversioned"), file)}
          onDelete={() => setDialog({ kind: "delete", nodes: menu.nodes.filter((n) => n.section === "unversioned") })}
          onRefresh={session.refreshAll}
        />
      )}
      {historyAt && (
        <Popup at={historyAt} onClose={() => setHistoryAt(undefined)} width={420}>
          <div className="popup-title">Commit Message History</div>
          <div className="popup-list">
            {history.map((m) => (
              <button
                key={m}
                className="popup-item"
                title={m}
                onClick={() => {
                  setMessage(m);
                  setHistoryAt(undefined);
                  messageRef.current?.focus();
                }}
              >
                <span className="history-message">{m.split("\n")[0]}</span>
              </button>
            ))}
            {history.length === 0 && <div className="popup-section">No messages yet</div>}
          </div>
        </Popup>
      )}
      {dialog?.kind === "rollback" && (
        <ConfirmDialog
          title="Rollback Changes"
          confirmLabel="Rollback"
          onClose={() => setDialog(undefined)}
          onConfirm={() => rollback(dialog.nodes, dialog.deleteAdded)}
        >
          <p>
            Revert {dialog.nodes.length === 1 ? "this file" : `these ${dialog.nodes.length} files`} to HEAD? Their changes
            will be lost.
          </p>
          <FileList nodes={dialog.nodes} home={home} />
          {dialog.nodes.some((n) => n.file.kind === "added" || n.file.kind === "renamed") && (
            <label className="amend">
              <input
                type="checkbox"
                checked={dialog.deleteAdded}
                onChange={(e) => setDialog({ ...dialog, deleteAdded: e.target.checked })}
              />{" "}
              Delete local copies of added files
            </label>
          )}
        </ConfirmDialog>
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title="Delete Files"
          confirmLabel="Delete"
          onClose={() => setDialog(undefined)}
          onConfirm={() => deleteFiles(dialog.nodes)}
        >
          <p>Delete {dialog.nodes.length === 1 ? "this file" : `these ${dialog.nodes.length} files`} from disk?</p>
          <FileList nodes={dialog.nodes} home={home} />
        </ConfirmDialog>
      )}
    </div>
  );
}

function FileList({ nodes, home }: { nodes: FileNode[]; home: string }) {
  return (
    <div className="dialog-list">
      {nodes.map((n) => (
        <div key={n.key} className="check-row" title={`${n.repo.path}/${n.file.path}`}>
          <FileText size={14} className="secondary" />
          <span className={`status-${n.file.kind}`}>{n.file.path}</span>
          <span className="secondary">{repoName(n.repo, home)}</span>
        </div>
      ))}
    </div>
  );
}

type MenuProps = {
  menu: Menu;
  onClose: () => void;
  onShowDiff: () => void;
  onRollback: () => void;
  onAdd: () => void;
  onIgnore: (file: IgnoreFile) => void;
  onDelete: () => void;
  onRefresh: () => void;
};

function ChangesMenu({ menu, onClose, onShowDiff, onRollback, onAdd, onIgnore, onDelete, onRefresh }: MenuProps) {
  const tracked = menu.nodes.some((n) => n.section === "changes");
  const unversioned = menu.nodes.filter((n) => n.section === "unversioned");
  const oneRepo = new Set(unversioned.map((n) => n.repo.path)).size === 1;
  const item = (label: string, hint: string, enabled: boolean, action: () => void, why?: string) => (
    <button
      key={label}
      className="popup-item"
      disabled={!enabled}
      title={enabled ? undefined : why}
      onClick={() => {
        onClose();
        action();
      }}
    >
      {label}
      <span className="hint">{hint}</span>
    </button>
  );
  return (
    <Popup at={menu.at} onClose={onClose}>
      <div className="popup-list" style={{ paddingTop: 4 }}>
        {item("Show Diff", "Ctrl+D", menu.nodes.length > 0, onShowDiff)}
        {item("Rollback...", "Ctrl+Alt+Z", tracked, onRollback, "Select changed files to roll back")}
        <div className="popup-separator" />
        {item("Add to VCS", "Ctrl+Alt+A", unversioned.length > 0, onAdd, "Select unversioned files to add")}
        {item("Delete...", "Delete", unversioned.length > 0, onDelete, "Select unversioned files to delete")}
        {unversioned.length > 0 && (
          <>
            <div className="popup-section">Add to .gitignore</div>
            {!oneRepo && <div className="popup-section">Select files from one repository</div>}
            {oneRepo && !menu.ignoreTargets && <div className="popup-section">Loading...</div>}
            {menu.ignoreTargets?.map((file) =>
              item(ignoreLabel(file), "", true, () => onIgnore(file)),
            )}
          </>
        )}
        <div className="popup-separator" />
        {item("Refresh", "", true, onRefresh)}
      </div>
    </Popup>
  );
}

function ignoreLabel(file: IgnoreFile): string {
  if (file.kind === "exclude") return ".git/info/exclude";
  return file.dir ? `${file.dir}/.gitignore` : ".gitignore";
}

function withOrigPaths(nodes: FileNode[]): string[] {
  return nodes.flatMap((n) => (n.file.orig_path ? [n.file.path, n.file.orig_path] : [n.file.path]));
}

function inclusion(files: FileNode[], isIncluded: (n: FileNode) => boolean): "all" | "some" | "none" {
  const count = files.filter(isIncluded).length;
  return count === 0 ? "none" : count === files.length ? "all" : "some";
}

function uniqueFiles(nodes: FileNode[]): FileNode[] {
  const seen = new Set<string>();
  return nodes.filter((n) => !seen.has(n.key) && seen.add(n.key));
}

function byRepo(nodes: FileNode[]): Map<string, FileNode[]> {
  const groups = new Map<string, FileNode[]>();
  for (const node of nodes) groups.set(node.repo.path, [...(groups.get(node.repo.path) ?? []), node]);
  return groups;
}

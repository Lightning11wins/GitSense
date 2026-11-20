import { useState } from "react";
import { ChevronDown, ChevronRight, FileText, FolderGit2, RefreshCw } from "lucide-react";
import type { FileChange, Repo } from "../protocol.gen";
import { useSession, type Session } from "./session";
import { baseName, dirName, repoName } from "./repos";
import "./CommitPanel.css";

type Group = { repo: Repo; branch: string | null; files: FileChange[] };

/** The Commit tool window: changes grouped by repo, and the commit message. */
export function CommitPanel({ session }: { session: Session }) {
  const repos = useSession(session, (s) => s.repos);
  const statuses = useSession(session, (s) => s.statuses);
  const home = useSession(session, (s) => s.info.home);
  const reposError = useSession(session, (s) => s.reposError);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string>();
  const [message, setMessage] = useState("");

  const tracked: Group[] = [];
  const untracked: Group[] = [];
  const errors: { repo: Repo; error: string }[] = [];
  for (const repo of repos) {
    if (repo.hidden) continue;
    const entry = statuses[repo.path];
    if (entry?.error) errors.push({ repo, error: entry.error });
    const status = entry?.status;
    if (!status) continue;
    const changes = status.changes.filter((c) => c.kind !== "untracked");
    const others = status.changes.filter((c) => c.kind === "untracked");
    if (changes.length) tracked.push({ repo, branch: status.branch, files: changes });
    if (others.length) untracked.push({ repo, branch: status.branch, files: others });
  }

  const toggle = (key: string) =>
    setCollapsed((old) => {
      const next = new Set(old);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  function renderSection(key: string, title: string, groups: Group[]) {
    const count = groups.reduce((n, g) => n + g.files.length, 0);
    if (count === 0) return null;
    const open = !collapsed.has(key);
    return (
      <>
        <Row depth={0} chevron={open} onToggle={() => toggle(key)} selected={selected === key} onSelect={() => setSelected(key)}>
          <span className="label section-label">{title}</span>
          <span className="hint">{count === 1 ? "1 file" : `${count} files`}</span>
        </Row>
        {open &&
          groups.map((group) => {
            const groupKey = `${key}/${group.repo.path}`;
            const groupOpen = !collapsed.has(groupKey);
            return (
              <div key={groupKey}>
                <Row
                  depth={1}
                  chevron={groupOpen}
                  onToggle={() => toggle(groupKey)}
                  selected={selected === groupKey}
                  onSelect={() => setSelected(groupKey)}
                >
                  <FolderGit2 size={14} className="secondary" />
                  <span className="label">{repoName(group.repo, home)}</span>
                  <span className="hint">{group.branch ?? "detached HEAD"}</span>
                </Row>
                {groupOpen &&
                  group.files.map((file) => {
                    const fileKey = `${groupKey}/${file.path}`;
                    return (
                      <Row
                        key={fileKey}
                        depth={2}
                        selected={selected === fileKey}
                        onSelect={() => setSelected(fileKey)}
                        onOpen={() => session.openDiff(group.repo.path, file)}
                      >
                        <FileText size={14} className="secondary" />
                        <span className={`label status-${file.kind}`} title={file.orig_path ? `Renamed from ${file.orig_path}` : undefined}>
                          {baseName(file.path)}
                        </span>
                        <span className="hint">{dirName(file.path)}</span>
                      </Row>
                    );
                  })}
              </div>
            );
          })}
      </>
    );
  }

  const empty = tracked.length === 0 && untracked.length === 0;
  return (
    <div className="commit-panel">
      <div className="tool-window-header">
        <span className="tool-window-title">Commit</span>
        <span className="spacer" />
        <button className="icon-button" title="Refresh" onClick={session.refreshAll}>
          <RefreshCw size={16} />
        </button>
      </div>
      <div className="tree changes-tree" tabIndex={0}>
        {reposError && <div className="error-text tree-message">{reposError}</div>}
        {errors.map(({ repo, error }) => (
          <div key={repo.path} className="error-text tree-message">
            {error}
          </div>
        ))}
        {renderSection("changes", "Changes", tracked)}
        {renderSection("unversioned", "Unversioned Files", untracked)}
        {empty && !reposError && <div className="secondary tree-message">No changes</div>}
      </div>
      <div className="commit-message">
        <textarea placeholder="Commit Message" value={message} onChange={(e) => setMessage(e.target.value)} />
        <div className="commit-buttons">
          <label className="amend">
            <input type="checkbox" disabled /> Amend
          </label>
          <span className="grow" />
          <button className="button primary" disabled>
            Commit
          </button>
          <button className="button" disabled>
            Commit and Push...
          </button>
        </div>
      </div>
    </div>
  );
}

type RowProps = {
  depth: number;
  /** Whether the node is expanded; undefined for leaves. */
  chevron?: boolean;
  onToggle?: () => void;
  /** Opens a leaf, on double-click. */
  onOpen?: () => void;
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
};

function Row({ depth, chevron, onToggle, onOpen, selected, onSelect, children }: RowProps) {
  return (
    <div
      className={`tree-row ${selected ? "selected" : ""}`}
      style={{ paddingLeft: 4 + depth * 16 }}
      onMouseDown={onSelect}
      onDoubleClick={onOpen ?? onToggle}
    >
      <span
        className="chevron"
        onMouseDown={(e) => {
          e.stopPropagation();
          onSelect();
          onToggle?.();
        }}
      >
        {chevron === undefined ? null : chevron ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </span>
      {children}
    </div>
  );
}

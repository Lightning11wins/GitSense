import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronRight, GitBranch, Search, Tag } from "lucide-react";
import type { Branches } from "../protocol.gen";
import { call } from "../api";
import { useSession, type Session } from "../workspace/session";
import { repoName } from "../workspace/repos";
import { Menu, Popup, type Point } from "../workspace/Popup";
import { BranchDialogView, branchActions, type BranchDialog, type BranchItem } from "../workspace/branchActions";

/** A branch name merged across repos. `name` includes the remote for remote branches. */
type Entry = { kind: "local" | "remote"; name: string; repos: string[]; current: boolean; ahead: number; behind: number };
type Loaded = { repo: string; branches?: Branches; error?: string };

type Props = {
  session: Session;
  /** Repos whose branches to list. */
  repos: string[];
  /** Changes when the repos' refs may have moved. */
  reloadKey: string;
  repoColor: (repo: string) => string;
  /** Filters the log to a branch, or to "HEAD". */
  onFilter: (branch: string) => void;
};

/** IntelliJ's branches tree beside the log: HEAD, then local and remote branches merged by name across repos. */
export function BranchesPanel({ session, repos, reloadKey, repoColor, onFilter }: Props) {
  const home = useSession(session, (s) => s.info.home);
  // Every git command that changes a repo is logged, and may move refs that statuses don't show.
  const lastCommand = useSession(session, (s) => s.console.at(-1));
  const [loaded, setLoaded] = useState<Loaded[]>([]);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(["local"]));
  const [selected, setSelected] = useState<string>();
  const [repoMenu, setRepoMenu] = useState<{ entry: Entry; at: Point }>();
  const [actionMenu, setActionMenu] = useState<{ entry: Entry; repo: string; at: Point }>();
  const [dialog, setDialog] = useState<{ repo: string; dialog: BranchDialog }>();

  useEffect(() => {
    let stale = false;
    Promise.all(
      repos.map((repo) =>
        call("branches.list", { repo }).then(
          (branches): Loaded => ({ repo, branches }),
          (e): Loaded => ({ repo, error: String(e) }),
        ),
      ),
    ).then((l) => stale || setLoaded(l));
    return () => {
      stale = true;
    };
  }, [repos.join("\n"), reloadKey, lastCommand]);

  const { local, remotes } = useMemo(() => {
    const local = new Map<string, Entry>();
    const remotes = new Map<string, Map<string, Entry>>();
    const add = (map: Map<string, Entry>, kind: Entry["kind"], name: string, repo: string) => {
      const entry = map.get(name) ?? { kind, name, repos: [], current: false, ahead: 0, behind: 0 };
      entry.repos.push(repo);
      map.set(name, entry);
      return entry;
    };
    for (const { repo, branches } of loaded) {
      for (const b of branches?.local ?? []) {
        const entry = add(local, "local", b.name, repo);
        entry.current ||= b.current;
        entry.ahead += b.ahead;
        entry.behind += b.behind;
      }
      for (const b of branches?.remote ?? []) {
        if (!remotes.has(b.remote)) remotes.set(b.remote, new Map());
        add(remotes.get(b.remote)!, "remote", `${b.remote}/${b.name}`, repo);
      }
    }
    return { local, remotes };
  }, [loaded]);

  const words = search.trim().toLowerCase();
  const match = (e: Entry) => e.name.toLowerCase().includes(words);
  const isOpen = (id: string) => !!words || expanded.has(id);
  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const sorted = (map: Map<string, Entry>) => [...map.values()].filter(match).sort((a, b) => (a.name < b.name ? -1 : 1));

  function item(entry: Entry, repo: string): BranchItem | undefined {
    const branches = loaded.find((l) => l.repo === repo)?.branches;
    if (entry.kind === "local") {
      const branch = branches?.local.find((b) => b.name === entry.name);
      return branch && { kind: "local", branch };
    }
    const branch = branches?.remote.find((b) => `${b.remote}/${b.name}` === entry.name);
    return branch && { kind: "remote", branch };
  }

  function openMenu(e: MouseEvent, entry: Entry) {
    e.preventDefault();
    setSelected(`${entry.kind}:${entry.name}`);
    const at = { x: e.clientX, y: e.clientY };
    if (entry.repos.length === 1) setActionMenu({ entry, repo: entry.repos[0], at });
    else setRepoMenu({ entry, at });
  }

  const closeMenus = () => (setRepoMenu(undefined), setActionMenu(undefined));
  const multiRepo = repos.length > 1;

  type Handlers = { onDoubleClick?: () => void; onContextMenu?: (e: MouseEvent) => void };
  const row = (id: string, depth: number, content: ReactNode, handlers: Handlers) => (
    <div
      key={id}
      className={`tree-row ${selected === id ? "selected" : ""}`}
      style={{ paddingLeft: 4 + depth * 16 }}
      onMouseDown={(e) => e.button === 0 && setSelected(id)}
      onDoubleClick={handlers.onDoubleClick}
      onContextMenu={handlers.onContextMenu ?? ((e) => e.preventDefault())}
    >
      {content}
    </div>
  );
  const group = (id: string, depth: number, label: string) =>
    row(
      `group:${id}`,
      depth,
      <>
        <span className="chevron" onMouseDown={(e) => e.button === 0 && toggle(id)} onDoubleClick={(e) => e.stopPropagation()}>
          {isOpen(id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="label">{label}</span>
      </>,
      { onDoubleClick: () => toggle(id) },
    );
  const branch = (entry: Entry, depth: number, label: string) =>
    row(
      `${entry.kind}:${entry.name}`,
      depth,
      <>
        <span className="chevron" />
        {entry.current ? <Tag size={14} className="current-branch" /> : <GitBranch size={14} className="secondary" />}
        <span className="label">{label}</span>
        {multiRepo && entry.repos.length < repos.length && (
          <span className="hint">({entry.repos.map((r) => repoName({ path: r }, home)).join(", ")})</span>
        )}
        {entry.behind > 0 && (
          <span className="log-branch-count update-icon" title="Incoming commits">
            <ArrowDownLeft size={12} />
            {entry.behind}
          </span>
        )}
        {entry.ahead > 0 && (
          <span className="log-branch-count commit-icon" title="Outgoing commits">
            <ArrowUpRight size={12} />
            {entry.ahead}
          </span>
        )}
      </>,
      { onDoubleClick: () => onFilter(entry.name), onContextMenu: (e) => openMenu(e, entry) },
    );

  const localEntries = sorted(local);
  const remoteGroups = [...remotes.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([remote, map]) => ({ remote, entries: sorted(map) }))
    .filter((g) => g.entries.length > 0);
  const rows: ReactNode[] = [];
  if (!words) {
    rows.push(row("head", 0, <span className="label">HEAD (Current Branch)</span>, { onDoubleClick: () => onFilter("HEAD") }));
  }
  if (localEntries.length > 0 || !words) {
    rows.push(group("local", 0, "Local"));
    if (isOpen("local")) rows.push(...localEntries.map((e) => branch(e, 1, e.name)));
  }
  if (remoteGroups.length > 0) {
    rows.push(group("remote", 0, "Remote"));
    if (isOpen("remote")) {
      for (const { remote, entries } of remoteGroups) {
        rows.push(group(`remote:${remote}`, 1, remote));
        if (isOpen(`remote:${remote}`)) rows.push(...entries.map((e) => branch(e, 2, e.name.slice(remote.length + 1))));
      }
    }
  }

  const actionRepo = actionMenu && loaded.find((l) => l.repo === actionMenu.repo)?.branches;
  const actionItem = actionMenu && item(actionMenu.entry, actionMenu.repo);
  return (
    <div className="log-branches">
      <label className="log-search log-branches-search">
        <Search size={14} className="secondary" />
        <input placeholder="Search branches" value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      <div className="tree log-branches-tree" tabIndex={0}>
        {loaded
          .filter((l) => l.error)
          .map((l) => (
            <div key={l.repo} className="error-text tree-message">
              {repoName({ path: l.repo }, home)}: {l.error}
            </div>
          ))}
        {rows}
        {words && rows.length === 0 && <div className="secondary tree-message">No matches</div>}
      </div>
      {repoMenu && (
        <Popup at={repoMenu.at} onClose={() => setRepoMenu(undefined)}>
          <div className="popup-list">
            {repoMenu.entry.repos.map((repo) => (
              <button
                key={repo}
                className="popup-item"
                title={repo}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  setActionMenu({ entry: repoMenu.entry, repo, at: { x: rect.right - 8, y: rect.top } });
                }}
              >
                <span className="log-repo-marker" style={{ background: repoColor(repo) }} />
                {repoName({ path: repo }, home)}
                <span className="hint" />
                <ChevronRight size={14} className="secondary" />
              </button>
            ))}
          </div>
        </Popup>
      )}
      {actionMenu && actionRepo && actionItem && (
        <Menu
          at={actionMenu.at}
          width={340}
          onClose={() => setActionMenu(undefined)}
          actions={branchActions(
            {
              session,
              repo: actionMenu.repo,
              branches: actionRepo,
              close: closeMenus,
              openDialog: (d) => (closeMenus(), setDialog({ repo: actionMenu.repo, dialog: d })),
            },
            actionItem,
          )}
        />
      )}
      {dialog && (
        <BranchDialogView
          session={session}
          repo={dialog.repo}
          dialog={dialog.dialog}
          onChange={(d) => setDialog({ repo: dialog.repo, dialog: d })}
          onClose={() => setDialog(undefined)}
        />
      )}
    </div>
  );
}

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, FolderTree, GitBranch, RefreshCw } from "lucide-react";
import type { Branches, LocalBranch, Worktree } from "../protocol.gen";
import { call } from "../api";
import { useSession, type Session } from "./session";
import { repoName } from "./repos";
import { Menu, Popup, type Point } from "./Popup";
import { BranchDialogView, branchActions, type BranchDialog, type BranchItem } from "./branchActions";

/** IntelliJ's branches popup for one repo: local, remote, and worktree entries, each with a menu of actions. */
export function BranchesPopup({ session, repo, at, onClose }: { session: Session; repo: string; at: Point; onClose: () => void }) {
  const home = useSession(session, (s) => s.info.home);
  const statuses = useSession(session, (s) => s.statuses);
  const [data, setData] = useState<{ branches: Branches; worktrees: Worktree[] }>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const [menu, setMenu] = useState<{ item: BranchItem; at: Point }>();
  const [dialog, setDialog] = useState<BranchDialog>();
  const listRef = useRef<HTMLDivElement>(null);

  async function load() {
    try {
      const [branches, worktrees] = await Promise.all([call("branches.list", { repo }), call("worktrees.list", { repo })]);
      setData({ branches, worktrees });
      setError(undefined);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    load();
  }, [repo]);

  const words = filter.toLowerCase();
  const match = (text: string) => text.toLowerCase().includes(words);
  const local = data?.branches.local.filter((b) => match(b.name)) ?? [];
  const remote = data?.branches.remote.filter((b) => match(`${b.remote}/${b.name}`)) ?? [];
  const worktrees = data?.worktrees.filter((w) => w.path !== repo && match(`${w.branch ?? ""} ${w.path}`)) ?? [];
  const items: BranchItem[] = [
    ...local.map((branch) => ({ kind: "local" as const, branch })),
    ...remote.map((branch) => ({ kind: "remote" as const, branch })),
    ...worktrees.map((worktree) => ({ kind: "worktree" as const, worktree })),
  ];

  function openMenu(index: number) {
    const row = listRef.current?.querySelector(`[data-index="${index}"]`);
    if (!row || !items[index]) return;
    const rect = row.getBoundingClientRect();
    setActive(index);
    setMenu({ item: items[index], at: { x: rect.right - 8, y: rect.top } });
  }

  function onSearchKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") setActive((i) => Math.min(i + 1, items.length - 1));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(i - 1, 0));
    else if (e.key === "Enter" || e.key === "ArrowRight") openMenu(active);
    else return;
    e.preventDefault();
  }

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (dialog) return <BranchDialogView session={session} repo={repo} dialog={dialog} onChange={setDialog} onClose={onClose} />;

  let index = 0;
  /** A row for `items[index]`; rows render in the same order as `items`. */
  const row = (icon: ReactNode, label: ReactNode, hint: ReactNode, title?: string) => {
    const i = index++;
    return (
      <button
        key={i}
        data-index={i}
        className={`popup-item ${i === active ? "active" : ""}`}
        title={title}
        onMouseEnter={() => setActive(i)}
        onClick={() => openMenu(i)}
      >
        {icon}
        {label}
        <span className="hint">{hint}</span>
        <ChevronRight size={14} className="secondary" />
      </button>
    );
  };

  return (
    <>
      <Popup at={at} onClose={onClose} width={460}>
        <div className="popup-title row">
          {repoName({ path: repo }, home)}
          <span className="grow" />
          <button
            className="icon-button"
            title="Fetch"
            onClick={async () => {
              try {
                await session.track("Fetching...", () => call("fetch", { repo }));
              } catch (e) {
                session.notify(String(e));
              }
              load();
            }}
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <input
          className="popup-search"
          placeholder="Search branches"
          autoFocus
          value={filter}
          onChange={(e) => (setFilter(e.target.value), setActive(0))}
          onKeyDown={onSearchKey}
        />
        <div className="popup-list" ref={listRef}>
          {!filter && (
            <>
              <button className="popup-item" onClick={() => setDialog({ kind: "new", start: "HEAD", name: "", checkout: true })}>
                New Branch...
              </button>
              <button className="popup-item" onClick={() => setDialog({ kind: "revision" })}>
                Checkout Tag or Revision...
              </button>
              <div className="popup-separator" />
            </>
          )}
          {error && <div className="error-text tree-message">{error}</div>}
          {!data && !error && <div className="secondary tree-message">Loading...</div>}
          {local.length > 0 && <div className="popup-section">Local</div>}
          {local.map((b) =>
            row(
              <GitBranch size={14} className={b.current ? "current-branch" : "secondary"} />,
              <span className={b.current ? "current-branch" : undefined}>{b.name}</span>,
              <>
                {b.worktree && !b.current && <FolderTree size={12} />}
                {trackHint(b)}
              </>,
              b.worktree && !b.current ? `Checked out in ${b.worktree}` : b.upstream ? `Tracks ${b.upstream}` : undefined,
            ),
          )}
          {remote.length > 0 && <div className="popup-section">Remote</div>}
          {remote.map((b) =>
            row(<GitBranch size={14} className="secondary" />, `${b.remote}/${b.name}`, null),
          )}
          {worktrees.length > 0 && <div className="popup-section">Worktrees</div>}
          {worktrees.map((w) =>
            row(
              <FolderTree size={14} className="secondary" />,
              repoName({ path: w.path }, home),
              worktreeHint(w, statuses[w.path]?.status?.changes.length),
              w.path,
            ),
          )}
          {data && items.length === 0 && filter && <div className="secondary tree-message">No matches</div>}
        </div>
      </Popup>
      {menu && <Menu at={menu.at} actions={branchActions({ session, repo, branches: data!.branches, close: onClose, openDialog: setDialog }, menu.item)} onClose={() => setMenu(undefined)} />}
    </>
  );
}

function trackHint(b: LocalBranch) {
  if (b.upstream_gone) return "upstream gone";
  const parts = [b.ahead > 0 && `↑${b.ahead}`, b.behind > 0 && `↓${b.behind}`].filter(Boolean);
  return parts.join(" ");
}

function worktreeHint(w: Worktree, changes: number | undefined) {
  const parts = [w.branch ?? "detached"];
  if (changes) parts.push(`${changes} changed`);
  if (w.unmerged) parts.push(`${w.unmerged} unmerged`);
  if (w.prunable) parts.push("missing");
  return parts.join(" · ");
}

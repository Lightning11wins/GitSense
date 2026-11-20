import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, FolderTree, GitBranch, RefreshCw } from "lucide-react";
import type { Branches, LocalBranch, RemoteBranch, Worktree } from "../protocol.gen";
import { call } from "../api";
import { useSession, type Session } from "./session";
import { repoName } from "./repos";
import { Popup } from "./Popup";
import { ConfirmDialog } from "./ConfirmDialog";
import { InputDialog } from "./InputDialog";

type Point = { x: number; y: number };
type Item =
  | { kind: "local"; branch: LocalBranch }
  | { kind: "remote"; branch: RemoteBranch }
  | { kind: "worktree"; worktree: Worktree };
type Action = { label: string; hint?: string; disabled?: string; run: () => void } | "separator";
type Dialog =
  | { kind: "new"; start: string; name: string; checkout: boolean }
  | { kind: "revision" }
  | { kind: "rename"; from: string }
  | { kind: "force_delete"; name: string; error: string }
  | { kind: "delete_remote"; remote: string; name: string }
  | { kind: "delete_worktree"; worktree: Worktree };

/** IntelliJ's branches popup for one repo: local, remote, and worktree entries, each with a menu of actions. */
export function BranchesPopup({ session, repo, at, onClose }: { session: Session; repo: string; at: Point; onClose: () => void }) {
  const home = useSession(session, (s) => s.info.home);
  const statuses = useSession(session, (s) => s.statuses);
  const [data, setData] = useState<{ branches: Branches; worktrees: Worktree[] }>();
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const [menu, setMenu] = useState<{ item: Item; at: Point }>();
  const [dialog, setDialog] = useState<Dialog>();
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

  /** Closes the popup and runs a repo operation in the background, reporting failure in the status bar. */
  async function run(label: string, work: () => Promise<unknown>) {
    onClose();
    try {
      await session.track(label, work);
    } catch (e) {
      session.notify(String(e));
    }
    session.refreshStatus(repo);
  }

  /** Runs an operation from a dialog, which shows a failure itself. */
  async function runInDialog(label: string, work: () => Promise<unknown>) {
    try {
      await session.track(label, work);
    } finally {
      session.refreshStatus(repo);
    }
  }

  const current = data?.branches.local.find((b) => b.current)?.name;
  const words = filter.toLowerCase();
  const match = (text: string) => text.toLowerCase().includes(words);
  const local = data?.branches.local.filter((b) => match(b.name)) ?? [];
  const remote = data?.branches.remote.filter((b) => match(`${b.remote}/${b.name}`)) ?? [];
  const worktrees = data?.worktrees.filter((w) => w.path !== repo && match(`${w.branch ?? ""} ${w.path}`)) ?? [];
  const items: Item[] = [
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

  function actions(item: Item): Action[] {
    if (item.kind === "worktree") {
      const w = item.worktree;
      return [
        {
          label: "Delete Worktree...",
          disabled: w.is_main ? "The main working tree cannot be deleted" : undefined,
          run: () => setDialog({ kind: "delete_worktree", worktree: w }),
        },
      ];
    }
    const noCurrent = current ? undefined : "HEAD is detached";
    if (item.kind === "remote") {
      const b = item.branch;
      const full = `${b.remote}/${b.name}`;
      const same = data?.branches.local.find((l) => l.name === b.name);
      return [
        {
          label: "Checkout",
          hint: same ? `as '${same.name}'` : undefined,
          disabled: same && (same.current ? "Already checked out" : checkedOutElsewhere(same)),
          run: () =>
            run(`Checking out ${full}...`, () =>
              call("checkout", {
                repo,
                target: same ? { kind: "branch", name: same.name } : { kind: "remote", remote: b.remote, name: b.name },
              }),
            ),
        },
        { label: `New Branch from '${full}'...`, run: () => setDialog({ kind: "new", start: full, name: b.name, checkout: true }) },
        "separator",
        {
          label: `Rebase '${current ?? "HEAD"}' onto '${full}'`,
          disabled: noCurrent,
          run: () => run(`Rebasing onto ${full}...`, () => call("rebase", { repo, onto: full, branch: null })),
        },
        {
          label: `Merge '${full}' into '${current ?? "HEAD"}'`,
          disabled: noCurrent,
          run: () => run(`Merging ${full}...`, () => call("merge", { repo, rev: full })),
        },
        "separator",
        { label: "Delete", run: () => setDialog({ kind: "delete_remote", remote: b.remote, name: b.name }) },
      ];
    }
    const b = item.branch;
    const elsewhere = checkedOutElsewhere(b);
    const isCurrent = b.current ? "This is the current branch" : undefined;
    return [
      {
        label: "Checkout",
        disabled: b.current ? "Already checked out" : elsewhere,
        run: () => run(`Checking out ${b.name}...`, () => call("checkout", { repo, target: { kind: "branch", name: b.name } })),
      },
      { label: `New Branch from '${b.name}'...`, run: () => setDialog({ kind: "new", start: b.name, name: "", checkout: true }) },
      {
        label: `Checkout and Rebase onto '${current ?? "HEAD"}'`,
        disabled: isCurrent ?? noCurrent ?? elsewhere,
        run: () => run(`Rebasing ${b.name}...`, () => call("rebase", { repo, onto: current!, branch: b.name })),
      },
      "separator",
      {
        label: `Rebase '${current ?? "HEAD"}' onto '${b.name}'`,
        disabled: isCurrent ?? noCurrent,
        run: () => run(`Rebasing onto ${b.name}...`, () => call("rebase", { repo, onto: b.name, branch: null })),
      },
      {
        label: `Merge '${b.name}' into '${current ?? "HEAD"}'`,
        disabled: isCurrent ?? noCurrent,
        run: () => run(`Merging ${b.name}...`, () => call("merge", { repo, rev: b.name })),
      },
      "separator",
      {
        label: "Update",
        disabled: !b.upstream ? "The branch has no upstream" : elsewhere,
        run: () =>
          run(`Updating ${b.name}...`, () =>
            b.current ? call("pull", { repo }) : call("branch.update", { repo, branch: b.name }),
          ),
      },
      { label: "Push...", run: () => (onClose(), session.openPush({ repo, name: b.name })) },
      "separator",
      { label: "Rename...", run: () => setDialog({ kind: "rename", from: b.name }) },
      { label: "Delete", disabled: isCurrent ?? elsewhere, run: () => deleteLocal(b.name) },
    ];
  }

  /** Deletes a merged branch, or asks before deleting an unmerged one. */
  async function deleteLocal(name: string) {
    setMenu(undefined);
    try {
      await session.track(`Deleting ${name}...`, () => call("branch.delete", { repo, name, remote: null, force: false }));
      session.notify(`Deleted branch ${name}.`);
      onClose();
    } catch (e) {
      setDialog({ kind: "force_delete", name, error: String(e) });
    }
  }

  if (dialog) {
    const title = repoName({ path: repo }, home);
    switch (dialog.kind) {
      case "new":
        return (
          <InputDialog
            title={`Create New Branch in ${title}`}
            label="New branch name"
            initial={dialog.name}
            confirmLabel="Create"
            onConfirm={(name) =>
              runInDialog(`Creating ${name}...`, () =>
                call("branch.create", { repo, name, start: dialog.start, checkout: dialog.checkout }),
              )
            }
            onClose={onClose}
          >
            <p className="secondary">Starts at {dialog.start}.</p>
            <label>
              <input
                type="checkbox"
                checked={dialog.checkout}
                onChange={(e) => setDialog({ ...dialog, checkout: e.target.checked })}
              />
              Checkout branch
            </label>
          </InputDialog>
        );
      case "revision":
        return (
          <InputDialog
            title={`Checkout Tag or Revision in ${title}`}
            label="Tag or revision"
            confirmLabel="Checkout"
            onConfirm={(rev) => runInDialog(`Checking out ${rev}...`, () => call("checkout", { repo, target: { kind: "revision", rev } }))}
            onClose={onClose}
          />
        );
      case "rename":
        return (
          <InputDialog
            title={`Rename Branch '${dialog.from}'`}
            label="New name"
            initial={dialog.from}
            confirmLabel="Rename"
            onConfirm={(to) => runInDialog(`Renaming ${dialog.from}...`, () => call("branch.rename", { repo, from: dialog.from, to }))}
            onClose={onClose}
          />
        );
      case "force_delete":
        return (
          <ConfirmDialog
            title="Delete Branch"
            confirmLabel="Delete Anyway"
            onConfirm={() =>
              runInDialog(`Deleting ${dialog.name}...`, () =>
                call("branch.delete", { repo, name: dialog.name, remote: null, force: true }),
              )
            }
            onClose={onClose}
          >
            <p className="error-text">{dialog.error}</p>
            <p>Delete branch '{dialog.name}' anyway? Commits only on this branch will be lost.</p>
          </ConfirmDialog>
        );
      case "delete_remote":
        return (
          <ConfirmDialog
            title="Delete Remote Branch"
            confirmLabel="Delete"
            onConfirm={() =>
              runInDialog(`Deleting ${dialog.remote}/${dialog.name}...`, () =>
                call("branch.delete", { repo, name: dialog.name, remote: dialog.remote, force: false }),
              )
            }
            onClose={onClose}
          >
            <p>
              Delete branch '{dialog.name}' on remote '{dialog.remote}'?
            </p>
          </ConfirmDialog>
        );
      case "delete_worktree":
        return (
          <WorktreeDeleteDialog
            worktree={dialog.worktree}
            changes={statuses[dialog.worktree.path]?.status?.changes.length}
            home={home}
            onConfirm={async (force, deleteBranch) => {
              await runInDialog("Deleting worktree...", () =>
                call("worktree.remove", { repo, path: dialog.worktree.path, force, delete_branch: deleteBranch }),
              );
              session.loadRepos("repos.list");
            }}
            onClose={onClose}
          />
        );
    }
  }

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
      {menu && (
        <Popup at={menu.at} onClose={() => setMenu(undefined)} width={340}>
          <div className="popup-list">
            {actions(menu.item).map((a, i) =>
              a === "separator" ? (
                <div key={i} className="popup-separator" />
              ) : (
                <button
                  key={i}
                  className="popup-item"
                  disabled={!!a.disabled}
                  title={a.disabled}
                  autoFocus={i === 0}
                  onClick={() => {
                    setMenu(undefined);
                    a.run();
                  }}
                >
                  {a.label}
                  {a.hint && <span className="hint">{a.hint}</span>}
                </button>
              ),
            )}
          </div>
        </Popup>
      )}
    </>
  );
}

function plural(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function checkedOutElsewhere(b: LocalBranch) {
  return b.worktree && !b.current ? `Checked out in ${b.worktree}` : undefined;
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

type WorktreeDeleteProps = {
  worktree: Worktree;
  /** Uncommitted changes, when the worktree is a known repo. */
  changes: number | undefined;
  home: string;
  onConfirm: (force: boolean, deleteBranch: boolean) => Promise<void>;
  onClose: () => void;
};

/** Confirms deleting a worktree, warning about work that would be lost. */
function WorktreeDeleteDialog({ worktree, changes, home, onConfirm, onClose }: WorktreeDeleteProps) {
  const [deleteBranch, setDeleteBranch] = useState(!!worktree.branch);
  const [force, setForce] = useState(false);
  const risky = !!changes || worktree.unmerged > 0;
  return (
    <ConfirmDialog
      title="Delete Worktree"
      confirmLabel={force ? "Force Delete" : "Delete"}
      blocker={risky && !force ? "Check Force to lose this work" : undefined}
      onConfirm={() => onConfirm(force, deleteBranch)}
      onClose={onClose}
    >
      <p>
        Delete the worktree at {repoName({ path: worktree.path }, home)}
        {worktree.branch ? ` on branch '${worktree.branch}'` : ""}?
      </p>
      {!!changes && <p className="warning-text">It has {plural(changes, "uncommitted change")}.</p>}
      {worktree.unmerged > 0 && (
        <p className="warning-text">
          {plural(worktree.unmerged, "commit")} at its HEAD {worktree.unmerged === 1 ? "is" : "are"} on no other branch or
          remote branch.
        </p>
      )}
      {worktree.branch && (
        <label>
          <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
          Delete branch '{worktree.branch}'
        </label>
      )}
      <label>
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
        Force: delete even with uncommitted changes or unmerged commits
      </label>
    </ConfirmDialog>
  );
}

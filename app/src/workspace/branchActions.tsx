import { useState } from "react";
import type { Branches, LocalBranch, RemoteBranch, Worktree } from "../protocol.gen";
import { call } from "../api";
import { useSession, type Session } from "./session";
import { repoName } from "./repos";
import type { MenuAction } from "./Popup";
import { ConfirmDialog } from "./ConfirmDialog";
import { InputDialog } from "./InputDialog";

export type BranchItem =
  | { kind: "local"; branch: LocalBranch }
  | { kind: "remote"; branch: RemoteBranch }
  | { kind: "worktree"; worktree: Worktree };
export type BranchDialog =
  | { kind: "new"; start: string; name: string; checkout: boolean }
  | { kind: "revision" }
  | { kind: "rename"; from: string }
  | { kind: "force_delete"; name: string; error: string }
  | { kind: "delete_remote"; remote: string; name: string }
  | { kind: "delete_worktree"; worktree: Worktree };

/** What branch actions need from the view showing them. */
export type BranchContext = {
  session: Session;
  repo: string;
  branches: Branches;
  /** Closes the view's popups once an action starts. */
  close: () => void;
  openDialog: (dialog: BranchDialog) => void;
};

/** The actions for one branch or worktree of `ctx.repo`, as in IntelliJ's branches popup. */
export function branchActions(ctx: BranchContext, item: BranchItem): MenuAction[] {
  const { session, repo, branches, close, openDialog } = ctx;

  /** Closes the view and runs a repo operation in the background, reporting failure in the status bar. */
  async function run(label: string, work: () => Promise<unknown>) {
    close();
    try {
      await session.track(label, work);
    } catch (e) {
      session.notify(String(e));
    }
    session.refreshStatus(repo);
  }

  /** Deletes a merged branch, or asks before deleting an unmerged one. */
  async function deleteLocal(name: string) {
    try {
      await session.track(`Deleting ${name}...`, () => call("branch.delete", { repo, name, remote: null, force: false }));
      session.notify(`Deleted branch ${name}.`);
      close();
    } catch (e) {
      openDialog({ kind: "force_delete", name, error: String(e) });
    }
  }

  const current = branches.local.find((b) => b.current)?.name;
  function compareActions(branch: string, isCurrent: string | undefined): MenuAction[] {
    return [
      "separator",
      {
        label: `Compare with '${current ?? "HEAD"}'`,
        disabled: isCurrent,
        run: () => (close(), session.openCompare(repo, current ?? "HEAD", branch)),
      },
      { label: "Show Diff with Working Tree", run: () => (close(), session.openCompare(repo, branch, null)) },
    ];
  }

  if (item.kind === "worktree") {
    const w = item.worktree;
    return [
      {
        label: "Delete Worktree...",
        disabled: w.is_main ? "The main working tree cannot be deleted" : undefined,
        run: () => openDialog({ kind: "delete_worktree", worktree: w }),
      },
    ];
  }
  const noCurrent = current ? undefined : "HEAD is detached";
  if (item.kind === "remote") {
    const b = item.branch;
    const full = `${b.remote}/${b.name}`;
    const same = branches.local.find((l) => l.name === b.name);
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
      { label: `New Branch from '${full}'...`, run: () => openDialog({ kind: "new", start: full, name: b.name, checkout: true }) },
      ...compareActions(full, undefined),
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
      { label: "Delete", run: () => openDialog({ kind: "delete_remote", remote: b.remote, name: b.name }) },
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
    { label: `New Branch from '${b.name}'...`, run: () => openDialog({ kind: "new", start: b.name, name: "", checkout: true }) },
    {
      label: `Checkout and Rebase onto '${current ?? "HEAD"}'`,
      disabled: isCurrent ?? noCurrent ?? elsewhere,
      run: () => run(`Rebasing ${b.name}...`, () => call("rebase", { repo, onto: current!, branch: b.name })),
    },
    ...compareActions(b.name, isCurrent),
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
        run(`Updating ${b.name}...`, () => (b.current ? call("pull", { repo }) : call("branch.update", { repo, branch: b.name }))),
    },
    { label: "Push...", run: () => (close(), session.openPush({ repo, name: b.name })) },
    "separator",
    { label: "Rename...", run: () => openDialog({ kind: "rename", from: b.name }) },
    { label: "Delete", disabled: isCurrent ?? elsewhere, run: () => deleteLocal(b.name) },
  ];
}

type DialogProps = {
  session: Session;
  repo: string;
  dialog: BranchDialog;
  onChange: (dialog: BranchDialog) => void;
  onClose: () => void;
};

/** The dialog a branch action opened. Its operation's failure shows in the dialog. */
export function BranchDialogView({ session, repo, dialog, onChange, onClose }: DialogProps) {
  const home = useSession(session, (s) => s.info.home);
  const statuses = useSession(session, (s) => s.statuses);

  async function runInDialog(label: string, work: () => Promise<unknown>) {
    try {
      await session.track(label, work);
    } finally {
      session.refreshStatus(repo);
    }
  }

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
            runInDialog(`Creating ${name}...`, () => call("branch.create", { repo, name, start: dialog.start, checkout: dialog.checkout }))
          }
          onClose={onClose}
        >
          <p className="secondary">Starts at {dialog.start}.</p>
          <label>
            <input type="checkbox" checked={dialog.checkout} onChange={(e) => onChange({ ...dialog, checkout: e.target.checked })} />
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
            runInDialog(`Deleting ${dialog.name}...`, () => call("branch.delete", { repo, name: dialog.name, remote: null, force: true }))
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

export function checkedOutElsewhere(b: LocalBranch) {
  return b.worktree && !b.current ? `Checked out in ${b.worktree}` : undefined;
}

function plural(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
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

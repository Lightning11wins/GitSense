use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::Method;

macro_rules! methods {
    ($($(#[$doc:meta])* $ty:ident = $name:literal ($params:ty) -> $result:ty;)*) => {
        $(
            $(#[$doc])*
            pub struct $ty;
            impl Method for $ty {
                const NAME: &'static str = $name;
                type Params = $params;
                type Result = $result;
            }
        )*

        /// Calls `visit` with every method's name, params type, and result type.
        pub fn for_each_method(visit: &mut impl crate::ts::MethodVisitor) {
            $(visit.visit::<$ty>();)*
        }
    };
}

methods! {
    /// Lists known repos, scanning the home dir first if none are stored.
    ReposList = "repos.list" (Empty) -> Vec<Repo>;
    /// Rescans the home dir for repos, keeping manually added and hidden ones.
    ReposScan = "repos.scan" (Empty) -> Vec<Repo>;
    /// Adds a repo by path. The path may be anywhere inside the repo.
    ReposAdd = "repos.add" (PathParams) -> Repo;
    ReposSetHidden = "repos.set_hidden" (SetHiddenParams) -> Empty;
    Status = "status" (RepoParams) -> RepoStatus;
    /// Reads one version of a file.
    FileRead = "file.read" (FileReadParams) -> FileContent;
    /// Writes a working-tree file.
    FileWrite = "file.write" (FileWriteParams) -> Empty;
    /// Commits the working-tree content of whole files, plus given content for other files. Other changes,
    /// staged or not, and the working tree stay as they are.
    Commit = "commit" (CommitParams) -> CommitResult;
    /// Reads a commit's full message.
    CommitMessage = "commit.message" (RevParams) -> String;
    /// Reverts tracked files to HEAD. Files not in HEAD become untracked, or are deleted with `delete_added`.
    Rollback = "rollback" (RollbackParams) -> Empty;
    /// Starts tracking untracked files.
    FilesAdd = "files.add" (PathsParams) -> Empty;
    /// Deletes working-tree files.
    FilesDelete = "files.delete" (PathsParams) -> Empty;
    /// Lists ignore files for the given paths: the root `.gitignore`, other existing `.gitignore` files whose
    /// dir holds every path, from the root down, then `info/exclude`.
    IgnoreTargets = "ignore.targets" (PathsParams) -> Vec<IgnoreFile>;
    /// Adds the given paths to an ignore file, creating it if needed.
    IgnoreAdd = "ignore.add" (IgnoreAddParams) -> Empty;
    /// Lists files a commit changed, compared with its first parent.
    CommitFiles = "commit.files" (RevParams) -> Vec<FileChange>;
    /// Lists commits newest first, in an order where children come before their parents.
    Log = "log" (LogParams) -> Vec<LogCommit>;
    /// Lists files that differ between two revisions.
    DiffFiles = "diff.files" (DiffFilesParams) -> Vec<FileChange>;
    /// Lists local and remote-tracking branches.
    BranchesList = "branches.list" (RepoParams) -> Branches;
    Checkout = "checkout" (CheckoutParams) -> Empty;
    BranchCreate = "branch.create" (BranchCreateParams) -> Empty;
    BranchRename = "branch.rename" (BranchRenameParams) -> Empty;
    /// Deletes a local branch, or a branch on a remote.
    BranchDelete = "branch.delete" (BranchDeleteParams) -> Empty;
    /// Fast-forwards a branch that is not checked out to its upstream.
    BranchUpdate = "branch.update" (BranchParams) -> Empty;
    /// Merges a revision into the current branch.
    Merge = "merge" (RevParams) -> Empty;
    /// Rebases `branch`, or the current branch, onto `onto`.
    Rebase = "rebase" (RebaseParams) -> Empty;
    RemotesList = "remotes.list" (RepoParams) -> Vec<String>;
    /// Fetches all remotes, pruning deleted branches.
    Fetch = "fetch" (RepoParams) -> Empty;
    /// Updates the current branch with `git pull --autostash`, merging or rebasing as configured.
    Pull = "pull" (RepoParams) -> Empty;
    /// Lists commits a push would send, newest first.
    PushOutgoing = "push.outgoing" (PushTargetParams) -> Vec<CommitInfo>;
    Push = "push" (PushParams) -> Empty;
    WorktreesList = "worktrees.list" (RepoParams) -> Vec<Worktree>;
    /// Removes a worktree. Without `force`, refuses when it has uncommitted changes or unmerged commits.
    WorktreeRemove = "worktree.remove" (WorktreeRemoveParams) -> Empty;
    // Changelists and partial commits.
    /// Reads a repo's changelists, dropping paths that no longer have changes.
    ChangelistsGet = "changelists.get" (RepoParams) -> Changelists;
    /// Adds an empty changelist. Returns the state after the change, as do the other changelist changes.
    ChangelistsCreate = "changelists.create" (ChangelistParams) -> Changelists;
    ChangelistsRename = "changelists.rename" (ChangelistRenameParams) -> Changelists;
    /// Deletes a changelist, moving its files to `move_to` or the default list. The default list can't be deleted.
    ChangelistsDelete = "changelists.delete" (ChangelistDeleteParams) -> Changelists;
    ChangelistsSetActive = "changelists.set_active" (ChangelistParams) -> Changelists;
    /// Moves files to a changelist, out of whichever list held them.
    ChangelistsMovePaths = "changelists.move_paths" (ChangelistPathsParams) -> Changelists;
    // Operations, conflicts, comparison, commit actions.
    /// Continues the merge, rebase, cherry-pick, or revert in progress, after its conflicts are resolved.
    /// A merge is finished with a commit using git's prepared message. Fails when none is in progress, or
    /// with the new conflicts when a rebase or cherry-pick stops again.
    OperationContinue = "operation.continue" (RepoParams) -> Empty;
    /// Abandons the operation in progress and restores the state from before it started.
    OperationAbort = "operation.abort" (RepoParams) -> Empty;
    /// Skips the current commit of a rebase, cherry-pick, or revert. Fails for a merge or when nothing is in progress.
    OperationSkip = "operation.skip" (RepoParams) -> Empty;
    /// Cherry-picks commits onto the current branch in the given order. A conflict leaves the cherry-pick in
    /// progress and fails with a message naming the number of conflicted files.
    CherryPick = "cherry_pick" (RevsParams) -> Empty;
    /// Reverts commits on the current branch in the given order, with git's default messages. A conflict leaves
    /// the revert in progress and fails with a message naming the number of conflicted files.
    Revert = "revert" (RevsParams) -> Empty;
    /// Moves the current branch to a revision. `soft` keeps the index and working tree, `mixed` resets the index,
    /// `hard` resets both, and `keep` resets both but fails if that would lose local changes.
    Reset = "reset" (ResetParams) -> Empty;
    /// Changes a commit's message and nothing else: the working tree and index stay as they are. `rev` must be
    /// HEAD or an ancestor of HEAD with no merge commits between them, and no operation may be in progress.
    CommitReword = "commit.reword" (RewordParams) -> Empty;
    /// Removes the last commit from the current branch and keeps its changes staged in the working tree. Refuses
    /// for a merge commit, the root commit, and while an operation is in progress.
    CommitUndo = "commit.undo" (RepoParams) -> Empty;
}

/// Params or result with no fields.
#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, TS)]
pub struct Empty {}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct PathParams {
    pub path: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct RepoParams {
    /// Absolute path of the repo's working tree root.
    pub repo: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct PathsParams {
    pub repo: String,
    /// Paths relative to the repo root.
    pub paths: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct RevParams {
    pub repo: String,
    pub rev: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct SetHiddenParams {
    pub repo: String,
    pub hidden: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct Repo {
    /// Absolute path of the working tree root. Identifies the repo.
    pub path: String,
    /// Absolute path of the shared git dir. Worktrees of one repo share it.
    pub common_dir: String,
    /// True for linked worktrees, false for the main working tree.
    pub is_worktree: bool,
    pub hidden: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct RepoStatus {
    /// Current branch, or None when HEAD is detached.
    pub branch: Option<String>,
    /// Commit hash of HEAD, or None before the first commit.
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub operation: Option<Operation>,
    /// Working tree changes compared with HEAD, sorted by path.
    pub changes: Vec<FileChange>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct FileChange {
    /// Path relative to the repo root.
    pub path: String,
    /// Previous path, for renames.
    pub orig_path: Option<String>,
    pub kind: ChangeKind,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct FileReadParams {
    pub repo: String,
    pub path: String,
    pub version: FileVersion,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FileVersion {
    WorkingTree,
    /// The file at a revision, such as `HEAD` or a commit hash.
    Revision {
        rev: String,
    },
    /// A stage of the index: 0 normally, 1 base, 2 ours, 3 theirs during conflicts.
    Index {
        stage: u8,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct FileContent {
    /// False when the file does not exist in that version.
    pub exists: bool,
    /// File text, or None when the file is missing or binary.
    pub text: Option<String>,
    pub binary: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct FileWriteParams {
    pub repo: String,
    pub path: String,
    pub text: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct CommitParams {
    pub repo: String,
    /// Files to commit, relative to the repo root. Renames need both paths. Untracked files are added.
    /// May be empty when amending, to change only the message.
    pub paths: Vec<String>,
    pub message: String,
    /// Replaces HEAD instead of adding a commit on top of it.
    pub amend: bool,
    /// Content to commit for some files in place of their working-tree content. These paths must not
    /// also be in `paths`. The working tree is not changed.
    #[serde(default)]
    #[ts(optional)]
    pub contents: Option<Vec<CommitContent>>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct CommitContent {
    /// Path relative to the repo root.
    pub path: String,
    /// The exact file content to commit, or None to delete the file in the commit.
    pub text: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct CommitResult {
    /// Hash of the new commit.
    pub hash: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct RollbackParams {
    pub repo: String,
    /// Tracked files, relative to the repo root. Renames need both paths.
    pub paths: Vec<String>,
    /// Deletes files that are not in HEAD instead of leaving them untracked.
    pub delete_added: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IgnoreFile {
    /// A `.gitignore` in `dir`, relative to the repo root ("" for the root).
    Gitignore { dir: String },
    /// The repo's `info/exclude`, which is not shared with other clones.
    Exclude,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct IgnoreAddParams {
    pub repo: String,
    pub file: IgnoreFile,
    /// Paths relative to the repo root. Each must be inside the ignore file's dir.
    pub paths: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct BranchParams {
    pub repo: String,
    pub branch: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct Branches {
    /// Sorted by name.
    pub local: Vec<LocalBranch>,
    /// Remote-tracking branches, sorted by name.
    pub remote: Vec<RemoteBranch>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct LocalBranch {
    pub name: String,
    /// Upstream as `remote/branch`.
    pub upstream: Option<String>,
    /// True when the upstream is configured but no longer exists.
    pub upstream_gone: bool,
    pub ahead: u32,
    pub behind: u32,
    /// Checked out in this working tree.
    pub current: bool,
    /// Path of the working tree where it is checked out, if any.
    pub worktree: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct RemoteBranch {
    pub remote: String,
    /// Branch name on the remote, without the remote prefix.
    pub name: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct CheckoutParams {
    pub repo: String,
    pub target: CheckoutTarget,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CheckoutTarget {
    Branch {
        name: String,
    },
    /// Creates a local branch tracking the remote branch.
    Remote {
        remote: String,
        name: String,
    },
    /// Detaches HEAD at a commit, tag, or other revision.
    Revision {
        rev: String,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct BranchCreateParams {
    pub repo: String,
    pub name: String,
    /// Revision the branch starts at.
    pub start: String,
    pub checkout: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct BranchRenameParams {
    pub repo: String,
    pub from: String,
    pub to: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct BranchDeleteParams {
    pub repo: String,
    pub name: String,
    /// Deletes the branch on this remote instead of the local branch.
    pub remote: Option<String>,
    /// Deletes a local branch even when it is not merged.
    pub force: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct RebaseParams {
    pub repo: String,
    pub onto: String,
    pub branch: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct PushTargetParams {
    pub repo: String,
    /// Local branch to push.
    pub branch: String,
    pub remote: String,
    /// Branch name on the remote.
    pub remote_branch: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct PushParams {
    pub repo: String,
    pub branch: String,
    pub remote: String,
    pub remote_branch: String,
    pub set_upstream: bool,
    pub force_with_lease: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct CommitInfo {
    pub hash: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    /// Author date in seconds since the Unix epoch.
    pub author_time: i64,
    pub subject: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct LogParams {
    pub repo: String,
    /// Revisions to list commits from; all branches, remote branches, tags, and HEAD when empty.
    pub revs: Vec<String>,
    /// Text in the author's name or email.
    pub author: Option<String>,
    /// Text in the message, or the start of the hash.
    pub text: Option<String>,
    /// Earliest commit date, in seconds since the Unix epoch.
    pub since: Option<i64>,
    /// Latest commit date, in seconds since the Unix epoch.
    pub until: Option<i64>,
    /// Only commits that changed these paths.
    pub paths: Vec<String>,
    /// Commits to skip, for paging.
    pub skip: u32,
    pub limit: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct LogCommit {
    pub hash: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    /// Author date in seconds since the Unix epoch.
    pub author_time: i64,
    /// Commit date in seconds since the Unix epoch.
    pub commit_time: i64,
    pub subject: String,
    /// HEAD points at this commit.
    pub head: bool,
    pub refs: Vec<LogRef>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct LogRef {
    pub kind: RefKind,
    /// Short name, like `main`, `origin/main`, or `v1.0`.
    pub name: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum RefKind {
    Local,
    Remote,
    Tag,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct DiffFilesParams {
    pub repo: String,
    /// None compares `to` with the empty tree.
    pub from: Option<String>,
    pub to: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct Worktree {
    pub path: String,
    /// None before the first commit.
    pub head: Option<String>,
    /// None when HEAD is detached.
    pub branch: Option<String>,
    pub is_main: bool,
    pub locked: bool,
    /// The worktree's directory is missing.
    pub prunable: bool,
    /// Commits at its HEAD that no other branch or remote branch contains.
    pub unmerged: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct WorktreeRemoveParams {
    pub repo: String,
    pub path: String,
    pub force: bool,
    /// Also deletes the worktree's branch.
    pub delete_branch: bool,
}

/// A repo's changelists. The first list is the default one.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct Changelists {
    /// Name of the active list. Changed files not assigned to a list are in it.
    pub active: String,
    pub lists: Vec<Changelist>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct Changelist {
    /// Unique within the repo.
    pub name: String,
    /// The default list always exists and can't be deleted.
    pub is_default: bool,
    /// Files assigned to this list, relative to the repo root, sorted.
    pub paths: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct ChangelistParams {
    pub repo: String,
    /// Changelist name.
    pub name: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct ChangelistRenameParams {
    pub repo: String,
    pub name: String,
    pub new_name: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct ChangelistDeleteParams {
    pub repo: String,
    pub name: String,
    /// Where the deleted list's files go. Defaults to the default list. It also becomes the active list
    /// when the deleted list was active.
    #[serde(default)]
    #[ts(optional)]
    pub move_to: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct ChangelistPathsParams {
    pub repo: String,
    /// Changelist name.
    pub name: String,
    /// Paths relative to the repo root.
    pub paths: Vec<String>,
}

// Operations, conflicts, comparison, commit actions.

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct RevsParams {
    pub repo: String,
    /// Revisions to apply, in order. Must not be empty.
    pub revs: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct ResetParams {
    pub repo: String,
    pub rev: String,
    pub mode: ResetMode,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
    Keep,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct RewordParams {
    pub repo: String,
    pub rev: String,
    /// The commit's new full message. Must not be empty.
    pub message: String,
}

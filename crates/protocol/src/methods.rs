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
    /// Commits the working-tree content of whole files. Other changes, staged or not, stay as they are.
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

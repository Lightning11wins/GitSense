//! Types for the shelf, patch, and blame methods.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{ChangeKind, FileChange, FileContent};

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct ShelfEntry {
    /// Identifies the entry within its repo.
    pub id: String,
    pub message: String,
    /// Creation time in seconds since the Unix epoch.
    pub created: i64,
    /// Commit the shelved changes were made against (HEAD when shelved).
    pub base: String,
    /// Shelved changes, sorted by path.
    pub files: Vec<FileChange>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct ShelfCreateParams {
    pub repo: String,
    pub message: String,
    /// Tracked paths relative to the repo root. Renames need both paths.
    pub paths: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct ShelfIdParams {
    pub repo: String,
    pub id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct ShelfFileParams {
    pub repo: String,
    pub id: String,
    /// The path of one of the entry's files, as the entry lists it.
    pub path: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct ShelfUnshelveParams {
    pub repo: String,
    pub id: String,
    /// Paths of entry files to unshelve, as the entry lists them. All files when omitted.
    pub paths: Option<Vec<String>>,
    /// Keeps the unshelved files in the entry.
    pub keep: bool,
}

/// The two sides of a file's diff.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct FileSides {
    pub before: FileContent,
    pub after: FileContent,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct PatchCommitsParams {
    pub repo: String,
    /// Commits, each patched on its own, in the order given.
    pub revs: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct PatchParams {
    pub repo: String,
    /// Patch text in `git diff` or `git format-patch` format.
    pub patch: String,
}

/// One file of a patch, as it would look applied to HEAD.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct PatchFile {
    pub path: String,
    /// Previous path, for renames.
    pub orig_path: Option<String>,
    pub kind: ChangeKind,
    /// The file at HEAD (at its previous path for renames).
    pub before: FileContent,
    /// The file with the patch applied.
    pub after: FileContent,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct BlameParams {
    pub repo: String,
    /// Tracked path relative to the repo root.
    pub path: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct BlameResult {
    /// The commits that last changed some line, in order of first appearance.
    pub commits: Vec<BlameCommit>,
    /// One entry per line of the working-tree file: an index into `commits`,
    /// or None for lines not committed yet.
    pub lines: Vec<Option<u32>>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct BlameCommit {
    pub hash: String,
    pub author_name: String,
    /// Author date in seconds since the Unix epoch.
    pub author_time: i64,
    pub summary: String,
}

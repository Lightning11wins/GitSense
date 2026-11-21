//! Patches: creating them from changes or commits, previewing them, and applying them.
//!
//! Patches are bytes in `git diff` format with full object ids and binary
//! content, so they can be applied three-way. Work that must not touch the
//! user's index runs against a temporary index file.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use gitsense_protocol::{Empty, FileChange, PatchCommitsParams, PatchFile, PatchParams, PathsParams};

use crate::commit::{index_paths, parse_name_status};
use crate::files::{content, read_object, repo_path};
use crate::git::{Git, git};
use crate::{Ctx, Error, Result};

/// Arguments for diffs that go into patches: stable prefixes whatever the user's
/// config says, no external diff or textconv, binary content included.
const DIFF_ARGS: [&str; 8] =
    ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "-M", "--src-prefix=a/", "--dst-prefix=b/"];

pub fn create_from_changes(ctx: &Ctx, params: PathsParams) -> Result<String> {
    let repo = Path::new(&params.repo);
    let head = head_commit(ctx, repo, "create a patch")?;
    let diff = changes_diff(ctx, &params.repo, &head, &params.paths)?;
    patch_text(diff.patch, "create a patch from changes")
}

pub fn create_from_commits(ctx: &Ctx, params: PatchCommitsParams) -> Result<String> {
    if params.revs.is_empty() {
        return Err(Error::new("Failed to create a patch from commits: no commits were given."));
    }
    let repo = Path::new(&params.repo);
    let mut patch = Vec::new();
    for rev in &params.revs {
        let out = git(ctx, repo)
            .args(["format-patch", "--stdout", "-1", "--no-numbered", "--no-signature"])
            .args(&DIFF_ARGS[3..])
            .args(["--end-of-options", rev])
            .run()?;
        if out.stdout.is_empty() {
            return Err(Error::new(format!("Failed to create a patch from commit '{rev}': it has no patch to show.")));
        }
        patch.extend(out.stdout);
    }
    patch_text(patch, "create a patch from commits")
}

pub fn preview(ctx: &Ctx, params: PatchParams) -> Result<Vec<PatchFile>> {
    let repo = Path::new(&params.repo);
    let head = head_commit(ctx, repo, "preview a patch")?;
    let applied = apply_to_tree(ctx, repo, &head, params.patch.as_bytes(), true)?;
    let mut files = Vec::new();
    for change in applied.files {
        let before_path = change.orig_path.as_deref().unwrap_or(&change.path);
        files.push(PatchFile {
            before: content(read_object(ctx, &params.repo, &format!("{head}:{before_path}"))?),
            after: content(read_object(ctx, &params.repo, &format!("{}:{}", applied.tree, change.path))?),
            path: change.path,
            orig_path: change.orig_path,
            kind: change.kind,
        });
    }
    Ok(files)
}

pub fn apply(ctx: &Ctx, params: PatchParams) -> Result<Empty> {
    apply_to_worktree(ctx, &params.repo, params.patch.as_bytes(), "apply the patch")?;
    Ok(Empty {})
}

fn patch_text(patch: Vec<u8>, action: &str) -> Result<String> {
    String::from_utf8(patch).map_err(|e| Error::new(format!("Failed to {action}: the patch is not valid UTF-8: {e}")))
}

/// The commit at HEAD, or an error saying that `action` needs one.
pub fn head_commit(ctx: &Ctx, repo: &Path, action: &str) -> Result<String> {
    let out = git(ctx, repo).args(["rev-parse", "--verify", "-q", "HEAD^{commit}"]).run_unchecked()?;
    if !out.success() {
        return Err(Error::new(format!("Failed to {action} in '{}': the repo has no commits.", repo.display())));
    }
    Ok(out.stdout_str()?.trim().to_string())
}

/// A temporary index file, deleted on drop. Changes made through it never
/// touch the repo's own index or working tree.
pub struct TempIndex {
    path: PathBuf,
}

impl TempIndex {
    /// An index holding the tree of `treeish`.
    pub fn new(ctx: &Ctx, repo: &Path, treeish: &str) -> Result<Self> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let name = format!("gitsense-index-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
        let index = Self { path: std::env::temp_dir().join(name) };
        index.git(ctx, repo).args(["read-tree", treeish]).run()?;
        Ok(index)
    }

    /// A git command that uses this index.
    pub fn git<'a>(&self, ctx: &Ctx, repo: &'a Path) -> Git<'a> {
        git(ctx, repo).env("GIT_INDEX_FILE", &self.path)
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// A diff of working-tree paths against a commit.
pub struct ChangesDiff {
    pub patch: Vec<u8>,
    pub files: Vec<FileChange>,
}

/// Diffs the working-tree state of `paths` against `head`. Untracked paths count as added and missing ones
/// as deleted.
pub fn changes_diff(ctx: &Ctx, repo: &str, head: &str, paths: &[String]) -> Result<ChangesDiff> {
    for path in paths {
        repo_path(repo, path)?;
    }
    let repo = Path::new(repo);
    let index = TempIndex::new(ctx, repo, head)?;
    if !paths.is_empty() {
        index.git(ctx, repo).args(["update-index", "--add", "--remove", "--"]).args(paths).run()?;
    }
    let patch = index.git(ctx, repo).args(DIFF_ARGS).args(["--cached", head]).run()?.stdout;
    let names = index.git(ctx, repo).args(["diff", "--cached", "--name-status", "-z", "-M", head]).run()?;
    Ok(ChangesDiff { patch, files: parse_name_status(names.stdout_str()?)? })
}

/// The result of applying a patch to a commit.
pub struct AppliedTree {
    /// A tree object with the patch applied.
    pub tree: String,
    /// What the patch changed, sorted by path.
    pub files: Vec<FileChange>,
}

/// Applies `patch` to the tree of `base` in a temporary index. With `three_way`, changes that don't match
/// `base` exactly may still apply. Fails when the patch does not apply cleanly.
pub fn apply_to_tree(ctx: &Ctx, repo: &Path, base: &str, patch: &[u8], three_way: bool) -> Result<AppliedTree> {
    let index = TempIndex::new(ctx, repo, base)?;
    let mut cmd = index.git(ctx, repo).args(["apply", "--cached", "--whitespace=nowarn"]);
    if three_way {
        cmd = cmd.arg("--3way");
    }
    let out = cmd.stdin(patch).run_unchecked()?;
    let listing = index.git(ctx, repo).args(["ls-files", "-u", "-z"]).run()?;
    let unmerged = unmerged_paths(listing.stdout_str()?);
    if !out.success() || !unmerged.is_empty() {
        let detail = if unmerged.is_empty() {
            out.stderr.trim().to_string()
        } else {
            format!("conflicts in {}", unmerged.iter().map(String::as_str).collect::<Vec<_>>().join(", "))
        };
        return Err(Error::new(format!("Failed to apply the patch to '{base}' in '{}': {detail}", repo.display())));
    }
    let tree = index.git(ctx, repo).arg("write-tree").run()?.stdout_str()?.trim().to_string();
    let names = git(ctx, repo).args(["diff-tree", "-r", "-z", "--name-status", "-M", base, &tree]).run()?;
    let mut files = parse_name_status(names.stdout_str()?)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(AppliedTree { tree, files })
}

/// A patch of what `patch` changes in `paths` when applied to `base`. Renames need both paths.
pub fn restrict(ctx: &Ctx, repo: &Path, base: &str, patch: &[u8], paths: &[String]) -> Result<Vec<u8>> {
    let applied = apply_to_tree(ctx, repo, base, patch, false)?;
    let out = git(ctx, repo).args(DIFF_ARGS).args([base, &applied.tree, "--"]).args(paths).run()?;
    Ok(out.stdout)
}

/// Paths named by `ls-files -u -z` output.
fn unmerged_paths(listing: &str) -> BTreeSet<String> {
    listing.split('\0').filter_map(|entry| entry.split_once('\t')).map(|(_, path)| path.to_string()).collect()
}

/// Applies `patch` to the working tree, three-way when needed. Added, deleted, and renamed files are
/// mirrored in the index; edits to existing files are not staged. On conflicts the working tree has
/// markers and the index has unmerged entries for the conflicted paths. Fails when HEAD is missing,
/// when the patch does not apply, or on conflicts, with "Failed to `action`: ...".
pub fn apply_to_worktree(ctx: &Ctx, repo: &str, patch: &[u8], action: &str) -> Result<()> {
    let repo = Path::new(repo);
    let head = head_commit(ctx, repo, action)?;
    // Apply against HEAD plus the working-tree state of every tracked file that differs from it, so edits
    // made since the patch's base take part in the three-way merge, whatever is staged. The patch's own
    // paths are not known up front: renames and copies hide their source paths from `git apply`.
    let index = TempIndex::new(ctx, repo, &head)?;
    let local = git(ctx, repo).args(["diff", "--name-only", "-z", &head]).run()?;
    if !local.stdout.is_empty() {
        index.git(ctx, repo).args(["update-index", "--add", "--remove", "-z", "--stdin"]).stdin(local.stdout).run()?;
    }
    // Entries need fresh stat data to count as matching the working tree. Files that differ stay as they are.
    index.git(ctx, repo).args(["update-index", "-q", "--refresh"]).run_unchecked()?;
    let before = index.git(ctx, repo).arg("write-tree").run()?.stdout_str()?.trim().to_string();
    let out =
        index.git(ctx, repo).args(["apply", "--3way", "--whitespace=nowarn"]).stdin(patch).logged().run_unchecked()?;
    let listing = index.git(ctx, repo).args(["ls-files", "-u", "-z"]).run()?;
    let listing = listing.stdout_str()?;
    let conflicted = unmerged_paths(listing);
    if !out.success() && conflicted.is_empty() {
        return Err(Error::new(format!("Failed to {action} in '{}': {}", repo.display(), out.stderr.trim())));
    }
    let names = index.git(ctx, repo).args(["diff-index", "--cached", "--name-status", "-z", "-M", &before]).run()?;
    let mut touched = BTreeSet::new();
    for change in parse_name_status(names.stdout_str()?)? {
        touched.extend(change.orig_path);
        touched.insert(change.path);
    }
    for path in &touched {
        repo_path(&repo.display().to_string(), path)?;
    }
    let touched: Vec<String> = touched.into_iter().collect();
    sync_index(ctx, repo, &touched, &conflicted)?;
    if conflicted.is_empty() {
        return Ok(());
    }
    // Replace the conflicted paths' index entries with the unmerged stages.
    let zeros = "0".repeat(listing.split(' ').nth(1).map_or(40, str::len));
    let mut info = String::new();
    for path in &conflicted {
        info.push_str(&format!("0 {zeros}\t{path}\0"));
    }
    info.push_str(listing);
    git(ctx, repo).args(["update-index", "-z", "--index-info"]).stdin(info).logged().run()?;
    let list = conflicted.iter().map(String::as_str).collect::<Vec<_>>().join(", ");
    Err(Error::new(format!("Failed to {action} in '{}': conflicts in {list}.", repo.display())))
}

/// Mirrors files the working tree gained or lost into the index, skipping `skip`.
fn sync_index(ctx: &Ctx, repo: &Path, touched: &[String], skip: &BTreeSet<String>) -> Result<()> {
    let paths: Vec<String> = touched.iter().filter(|p| !skip.contains(*p)).cloned().collect();
    let in_index = index_paths(ctx, repo, &paths)?;
    let exists = |p: &&String| repo.join(p).symlink_metadata().is_ok();
    let added: Vec<&String> = paths.iter().filter(|p| exists(p) && !in_index.contains(*p)).collect();
    let deleted: Vec<&String> = paths.iter().filter(|p| !exists(p) && in_index.contains(*p)).collect();
    if !added.is_empty() {
        git(ctx, repo).args(["update-index", "--add", "--"]).args(added).logged().run()?;
    }
    if !deleted.is_empty() {
        git(ctx, repo).args(["update-index", "--remove", "--"]).args(deleted).logged().run()?;
    }
    Ok(())
}

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use gitsense_protocol::{ChangeKind, CommitContent, CommitParams, CommitResult, FileChange, RevParams};

use crate::files::repo_path;
use crate::{Ctx, Error, Result, git::git};

pub fn commit(ctx: &Ctx, params: CommitParams) -> Result<CommitResult> {
    let repo = Path::new(&params.repo);
    let partial = params.contents.as_deref().unwrap_or_default();
    if params.paths.is_empty() && partial.is_empty() && !params.amend {
        return Err(Error::new("Failed to commit: no files were selected."));
    }
    if params.message.trim().is_empty() {
        return Err(Error::new("Failed to commit: the commit message is empty."));
    }
    for path in params.paths.iter().chain(partial.iter().map(|c| &c.path)) {
        repo_path(&params.repo, path)?;
    }
    if !partial.is_empty() {
        check_partial_paths(&params.paths, partial)?;
        commit_with_contents(ctx, repo, &params, partial)?;
        return head_hash(ctx, repo);
    }
    let tracked = index_paths(ctx, repo, &params.paths)?;
    let untracked: Vec<&String> =
        params.paths.iter().filter(|p| !tracked.contains(*p) && repo.join(p).symlink_metadata().is_ok()).collect();
    if !untracked.is_empty() {
        git(ctx, repo).args(["add", "--"]).args(untracked).logged().run()?;
    }
    // `--only` commits these paths from the working tree through a temporary index, leaving other staged changes.
    let mut cmd = git(ctx, repo).args(["commit", "--only", "--file=-"]);
    if params.amend {
        cmd = cmd.arg("--amend");
    }
    cmd.arg("--").args(&params.paths).stdin(params.message).logged().run()?;
    head_hash(ctx, repo)
}

fn head_hash(ctx: &Ctx, repo: &Path) -> Result<CommitResult> {
    let out = git(ctx, repo).args(["rev-parse", "HEAD"]).run()?;
    Ok(CommitResult { hash: out.stdout_str()?.trim().to_string() })
}

/// Refuses a path that is listed twice, or both as a whole file and with content.
fn check_partial_paths(whole: &[String], partial: &[CommitContent]) -> Result<()> {
    let mut seen: HashSet<&str> = whole.iter().map(String::as_str).collect();
    for content in partial {
        if !seen.insert(&content.path) {
            return Err(Error::new(format!("Failed to commit '{}': it is listed more than once.", content.path)));
        }
    }
    Ok(())
}

/// A scratch index file in the repo's git dir, deleted when dropped.
struct TempIndex(PathBuf);

impl TempIndex {
    fn new(ctx: &Ctx, repo: &Path) -> Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let out = git(ctx, repo).args(["rev-parse", "--absolute-git-dir"]).run()?;
        let name = format!("gitsense-index-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed));
        Ok(Self(Path::new(out.stdout_str()?.trim()).join(name)))
    }

    /// Runs a git command that reads and writes this index instead of the repo's.
    fn git<'a>(&self, ctx: &Ctx, repo: &'a Path) -> crate::git::Git<'a> {
        git(ctx, repo).env("GIT_INDEX_FILE", &self.0)
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let _ = std::fs::remove_file(self.0.with_extension("lock"));
    }
}

/// Commits HEAD's content with the whole-file `paths` taken from the working tree and the `partial` files given
/// content, using a scratch index so the working tree and the repo's index are not touched while committing.
/// Afterwards the repo's index matches the new HEAD for every committed path.
fn commit_with_contents(ctx: &Ctx, repo: &Path, params: &CommitParams, partial: &[CommitContent]) -> Result<()> {
    let index = TempIndex::new(ctx, repo)?;
    let has_head = git(ctx, repo).args(["rev-parse", "--verify", "-q", "HEAD"]).run_unchecked()?.success();
    if has_head {
        index.git(ctx, repo).args(["read-tree", "HEAD"]).run()?;
    }
    if !params.paths.is_empty() {
        index.git(ctx, repo).args(["add", "--all", "--"]).args(&params.paths).run()?;
    }
    stage_contents(ctx, repo, &index, partial)?;

    let mut cmd = index.git(ctx, repo).args(["commit", "--file=-"]);
    if params.amend {
        cmd = cmd.arg("--amend");
    }
    cmd.stdin(params.message.as_str()).logged().run()?;

    let paths: Vec<&String> = params.paths.iter().chain(partial.iter().map(|c| &c.path)).collect();
    git(ctx, repo).args(["reset", "-q", "HEAD", "--"]).args(paths).logged().run()?;
    Ok(())
}

/// Sets each file's entry in the scratch index to its given content, keeping its mode, or removes it.
fn stage_contents(ctx: &Ctx, repo: &Path, index: &TempIndex, partial: &[CommitContent]) -> Result<()> {
    let listed =
        index.git(ctx, repo).args(["ls-files", "--stage", "-z", "--"]).args(partial.iter().map(|c| &c.path)).run()?;
    let modes: HashMap<&str, &str> = listed
        .stdout_str()?
        .split('\0')
        .filter_map(|record| {
            let (info, path) = record.split_once('\t')?;
            Some((path, info.split(' ').next()?))
        })
        .collect();

    let mut updates = String::new();
    let mut removals = String::new();
    for content in partial {
        let path = content.path.as_str();
        let mode = modes.get(path).copied();
        if mode == Some("160000") {
            return Err(Error::new(format!("Failed to commit content for '{path}': it is a submodule.")));
        }
        match &content.text {
            Some(text) => {
                let out = index.git(ctx, repo).args(["hash-object", "-w", "--stdin"]).stdin(text.as_str()).run()?;
                let mode = mode.unwrap_or(if is_executable(&repo.join(path)) { "100755" } else { "100644" });
                updates.push_str(&format!("{mode} {}\t{path}\0", out.stdout_str()?.trim()));
            }
            None if mode.is_some() => removals.push_str(&format!("{path}\0")),
            None => {
                return Err(Error::new(format!("Failed to delete '{path}' in the commit: it is not in HEAD.")));
            }
        }
    }
    if !updates.is_empty() {
        index.git(ctx, repo).args(["update-index", "-z", "--index-info"]).stdin(updates).run()?;
    }
    if !removals.is_empty() {
        index.git(ctx, repo).args(["update-index", "--force-remove", "-z", "--stdin"]).stdin(removals).run()?;
    }
    Ok(())
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
}

pub fn message(ctx: &Ctx, params: RevParams) -> Result<String> {
    let out = git(ctx, Path::new(&params.repo))
        .args(["log", "-1", "--format=%B", "--end-of-options", &params.rev, "--"])
        .run()?;
    Ok(out.stdout_str()?.trim_end().to_string())
}

pub fn files(ctx: &Ctx, params: RevParams) -> Result<Vec<FileChange>> {
    let repo = Path::new(&params.repo);
    let out = git(ctx, repo)
        .args(["rev-parse", "--verify", "--end-of-options", &format!("{}^{{commit}}", params.rev)])
        .run()?;
    let hash = out.stdout_str()?.trim().to_string();
    let diff = git(ctx, repo).args(["diff-tree", "-r", "-z", "--name-status", "-M", "--no-commit-id"]);
    // Compare with the first parent, so merges list what they brought in.
    let has_parent =
        git(ctx, repo).args(["rev-parse", "--verify", "-q", &format!("{hash}^1")]).run_unchecked()?.success();
    let out =
        if has_parent { diff.args([format!("{hash}^1"), hash]) } else { diff.args(["--root".into(), hash]) }.run()?;
    parse_name_status(out.stdout_str()?)
}

/// Parses `git diff --name-status -z` output.
pub fn parse_name_status(text: &str) -> Result<Vec<FileChange>> {
    let mut fields = text.split('\0').filter(|f| !f.is_empty());
    let mut changes = Vec::new();
    while let Some(status) = fields.next() {
        let bad = || Error::new(format!("Failed to parse diff status {status:?}."));
        let mut path = || fields.next().map(String::from).ok_or_else(bad);
        let change = match status.chars().next() {
            Some('R') => {
                let orig = path()?;
                FileChange { path: path()?, orig_path: Some(orig), kind: ChangeKind::Renamed }
            }
            Some('A') | Some('C') => FileChange { path: path()?, orig_path: None, kind: ChangeKind::Added },
            Some('D') => FileChange { path: path()?, orig_path: None, kind: ChangeKind::Deleted },
            Some('M') | Some('T') => FileChange { path: path()?, orig_path: None, kind: ChangeKind::Modified },
            _ => return Err(bad()),
        };
        changes.push(change);
    }
    Ok(changes)
}

/// The given paths that are in the index.
pub fn index_paths(ctx: &Ctx, repo: &Path, paths: &[String]) -> Result<HashSet<String>> {
    if paths.is_empty() {
        return Ok(HashSet::new());
    }
    let out = git(ctx, repo).args(["ls-files", "-z", "--cached", "--"]).args(paths).run()?;
    Ok(out.stdout_str()?.split('\0').filter(|p| !p.is_empty()).map(String::from).collect())
}

use std::collections::HashSet;
use std::path::Path;

use gitsense_protocol::{ChangeKind, CommitParams, CommitResult, FileChange, RevParams};

use crate::files::repo_path;
use crate::{Ctx, Error, Result, git::git};

pub fn commit(ctx: &Ctx, params: CommitParams) -> Result<CommitResult> {
    let repo = Path::new(&params.repo);
    if params.paths.is_empty() && !params.amend {
        return Err(Error::new("Failed to commit: no files were selected."));
    }
    if params.message.trim().is_empty() {
        return Err(Error::new("Failed to commit: the commit message is empty."));
    }
    for path in &params.paths {
        repo_path(&params.repo, path)?;
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
    let out = git(ctx, repo).args(["rev-parse", "HEAD"]).run()?;
    Ok(CommitResult { hash: out.stdout_str()?.trim().to_string() })
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
fn parse_name_status(text: &str) -> Result<Vec<FileChange>> {
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

use std::collections::HashSet;
use std::path::Path;

use gitsense_protocol::{CommitParams, CommitResult, RevParams};

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

/// The given paths that are in the index.
pub fn index_paths(ctx: &Ctx, repo: &Path, paths: &[String]) -> Result<HashSet<String>> {
    if paths.is_empty() {
        return Ok(HashSet::new());
    }
    let out = git(ctx, repo).args(["ls-files", "-z", "--cached", "--"]).args(paths).run()?;
    Ok(out.stdout_str()?.split('\0').filter(|p| !p.is_empty()).map(String::from).collect())
}

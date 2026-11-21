//! Actions on existing commits: reword and undo.

use std::path::Path;

use gitsense_protocol::{Empty, Operation, RewordParams};

use crate::ops::{in_progress, require_settled};
use crate::{Ctx, Error, Result, git::git};

/// The full hash of the commit `rev` names.
fn resolve(ctx: &Ctx, repo: &Path, rev: &str) -> Result<String> {
    let out = git(ctx, repo)
        .args(["rev-parse", "--verify", "--end-of-options", &format!("{rev}^{{commit}}")])
        .run_unchecked()?;
    if !out.success() {
        return Err(Error::new(format!("Failed to find commit '{rev}' in '{}'.", repo.display())));
    }
    Ok(out.stdout_str()?.trim().to_string())
}

pub fn reword(ctx: &Ctx, params: RewordParams) -> Result<Empty> {
    let repo = Path::new(&params.repo);
    let what = format!("reword '{}'", params.rev);
    let repo_name = &params.repo;
    if params.message.trim().is_empty() {
        return Err(Error::new(format!("Failed to {what} in '{repo_name}': the new message is empty.")));
    }
    require_settled(repo, &what)?;
    let hash = resolve(ctx, repo, &params.rev)?;
    let head = resolve(ctx, repo, "HEAD")?;
    if hash == head {
        // `--only` with no paths leaves the staged changes out of the amended commit.
        let cmd = git(ctx, repo).args(["commit", "--amend", "--only", "--allow-empty", "--file=-"]);
        cmd.stdin(params.message).logged().run()?;
        return Ok(Empty {});
    }

    let ancestor = git(ctx, repo).args(["merge-base", "--is-ancestor", &hash, &head]).run_unchecked()?;
    if !ancestor.success() {
        return Err(Error::new(format!(
            "Failed to {what} in '{repo_name}': commit {hash} is not an ancestor of HEAD."
        )));
    }
    let parents = git(ctx, repo).args(["rev-list", "--parents", "--max-count=1", &hash]).run()?;
    let parent_count = parents.stdout_str()?.split_whitespace().count() - 1;
    if parent_count > 1 {
        return Err(Error::new(format!("Failed to {what} in '{repo_name}': commit {hash} is a merge commit.")));
    }
    let merges = git(ctx, repo).args(["rev-list", "--merges", &format!("{hash}..{head}")]).run()?;
    if let Some(merge) = merges.stdout_str()?.lines().next() {
        return Err(Error::new(format!(
            "Failed to {what} in '{repo_name}': merge commit {merge} lies between it and HEAD."
        )));
    }

    // An `amend!` commit holds the new message, and autosquash folds it into its target.
    let fixup_message = format!("amend! {hash}\n\n{}", params.message);
    let fixup_cmd = git(ctx, repo).args(["commit", "--allow-empty", "--only", "--no-verify", "--file=-"]);
    fixup_cmd.stdin(fixup_message).logged().run()?;
    let fixup = resolve(ctx, repo, "HEAD")?;

    let base = if parent_count == 0 { "--root".to_string() } else { format!("{hash}^") };
    let rebase = git(ctx, repo)
        .args(["rebase", "--interactive", "--autosquash", "--autostash", &base])
        .env("GIT_SEQUENCE_EDITOR", "true")
        .logged()
        .run();
    if let Err(e) = rebase {
        restore(ctx, repo, &fixup);
        return Err(Error::new(format!("Failed to {what} in '{repo_name}': {e}")));
    }
    Ok(Empty {})
}

/// Undoes a failed reword: stops the rebase and drops the temporary commit, keeping the index.
fn restore(ctx: &Ctx, repo: &Path, fixup: &str) {
    if in_progress(repo).ok().flatten() == Some(Operation::Rebase) {
        let _ = git(ctx, repo).args(["rebase", "--abort"]).logged().run();
    }
    if resolve(ctx, repo, "HEAD").is_ok_and(|head| head == fixup) {
        let _ = git(ctx, repo).args(["reset", "--soft", "HEAD^"]).logged().run();
    }
}

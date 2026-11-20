use std::path::Path;

use gitsense_protocol::{Empty, RepoParams, Worktree, WorktreeRemoveParams};

use crate::branches::check_name;
use crate::{Ctx, Error, Result, git::git};

pub fn list(ctx: &Ctx, params: RepoParams) -> Result<Vec<Worktree>> {
    let repo = Path::new(&params.repo);
    let out = git(ctx, repo).args(["worktree", "list", "--porcelain", "-z"]).run()?;
    let mut worktrees: Vec<Worktree> = Vec::new();
    for field in out.stdout_str()?.split('\0') {
        let (key, value) = field.split_once(' ').unwrap_or((field, ""));
        if key == "worktree" {
            worktrees.push(Worktree {
                path: value.to_string(),
                head: None,
                branch: None,
                is_main: worktrees.is_empty(),
                locked: false,
                prunable: false,
                unmerged: 0,
            });
            continue;
        }
        let Some(worktree) = worktrees.last_mut() else { continue };
        match key {
            "HEAD" if value.chars().any(|c| c != '0') => worktree.head = Some(value.to_string()),
            "branch" => worktree.branch = Some(value.trim_start_matches("refs/heads/").to_string()),
            "locked" => worktree.locked = true,
            "prunable" => worktree.prunable = true,
            _ => {}
        }
    }
    for worktree in &mut worktrees {
        worktree.unmerged = unmerged(ctx, repo, worktree)?;
    }
    Ok(worktrees)
}

/// Commits at the worktree's HEAD that no other branch or remote branch contains.
fn unmerged(ctx: &Ctx, repo: &Path, worktree: &Worktree) -> Result<u32> {
    let Some(head) = &worktree.head else { return Ok(0) };
    let mut cmd = git(ctx, repo).args(["rev-list", "--count", head, "--not"]);
    if let Some(branch) = &worktree.branch {
        // Relative to refs/heads for `--branches`; branch names cannot contain glob characters.
        cmd = cmd.arg(format!("--exclude={branch}"));
    }
    let out = cmd.args(["--branches", "--remotes"]).run()?;
    let text = out.stdout_str()?.trim();
    text.parse().map_err(|_| Error::new(format!("Failed to parse a commit count {text:?}.")))
}

pub fn remove(ctx: &Ctx, params: WorktreeRemoveParams) -> Result<Empty> {
    let repo = Path::new(&params.repo);
    let worktrees = list(ctx, RepoParams { repo: params.repo.clone() })?;
    let worktree = worktrees
        .into_iter()
        .find(|w| w.path == params.path)
        .ok_or_else(|| Error::new(format!("Failed to find a worktree at '{}'.", params.path)))?;
    if worktree.is_main {
        return Err(Error::new(format!("Failed to remove '{}': it is the main working tree.", params.path)));
    }
    if !params.force && !worktree.prunable {
        let status = git(ctx, Path::new(&worktree.path)).args(["status", "--porcelain", "-z"]).run()?;
        if !status.stdout.is_empty() {
            return Err(Error::new(format!("Failed to remove '{}': it has uncommitted changes.", params.path)));
        }
    }
    if !params.force && worktree.unmerged > 0 {
        return Err(Error::new(format!(
            "Failed to remove '{}': {} commit(s) at its HEAD are on no other branch.",
            params.path, worktree.unmerged
        )));
    }
    let mut cmd = git(ctx, repo).args(["worktree", "remove"]);
    if params.force {
        // Twice to also remove locked worktrees.
        cmd = cmd.args(["--force", "--force"]);
    }
    if worktree.prunable {
        git(ctx, repo).args(["worktree", "prune"]).logged().run()?;
    } else {
        cmd.arg(&worktree.path).logged().run()?;
    }
    if params.delete_branch
        && let Some(branch) = &worktree.branch
    {
        check_name(branch)?;
        // Deleting is safe: unmerged commits were refused above unless forced.
        git(ctx, repo).args(["branch", "-D", branch]).logged().run()?;
    }
    Ok(Empty {})
}

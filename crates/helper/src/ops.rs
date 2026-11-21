//! Operations that span several commits or steps: continuing and aborting merges and rebases, cherry-pick,
//! revert, and reset.

use std::path::Path;

use gitsense_protocol::{Empty, Operation, RepoParams, ResetMode, ResetParams, RevsParams};

use crate::git::{Git, git};
use crate::repos::GitDirs;
use crate::status::operation;
use crate::{Ctx, Error, Result};

/// The operation in progress in a repo, or None.
pub fn in_progress(repo: &Path) -> Result<Option<Operation>> {
    let dirs =
        GitDirs::find(repo).ok_or_else(|| Error::new(format!("Failed to find a git repo at '{}'.", repo.display())))?;
    Ok(operation(&dirs.git_dir))
}

/// Fails when an operation is in progress, for actions that must start from a settled repo.
pub fn require_settled(repo: &Path, action: &str) -> Result<()> {
    match in_progress(repo)? {
        None => Ok(()),
        Some(op) => Err(Error::new(format!(
            "Failed to {action} in '{}': a {} is in progress.",
            repo.display(),
            operation_name(op)
        ))),
    }
}

fn operation_name(op: Operation) -> &'static str {
    match op {
        Operation::Merge => "merge",
        Operation::Rebase => "rebase",
        Operation::CherryPick => "cherry-pick",
        Operation::Revert => "revert",
    }
}

/// Runs a git command that may stop on conflicts. A conflict leaves the operation in progress and fails with
/// a message naming `what` and the number of conflicted files.
pub fn run_stoppable(ctx: &Ctx, repo: &Path, cmd: Git, what: &str) -> Result<()> {
    let out = cmd.logged().run_unchecked()?;
    if out.success() {
        return Ok(());
    }
    let conflicts = git(ctx, repo).args(["ls-files", "-u", "-z"]).run()?;
    let files: std::collections::BTreeSet<&str> =
        conflicts.stdout_str()?.split('\0').filter_map(|entry| entry.split_once('\t').map(|(_, path)| path)).collect();
    if files.is_empty() {
        return Err(Error::new(format!("Failed to {what}: {}", out.stderr.trim())));
    }
    Err(Error::new(format!(
        "Failed to {what}: {} file(s) have conflicts to resolve, then continue or abort the operation.",
        files.len()
    )))
}

fn running(repo: &Path, action: &str) -> Result<Operation> {
    in_progress(repo)?.ok_or_else(|| {
        Error::new(format!("Failed to {action} the operation in '{}': none is in progress.", repo.display()))
    })
}

pub fn continue_operation(ctx: &Ctx, params: RepoParams) -> Result<Empty> {
    let repo = Path::new(&params.repo);
    let op = running(repo, "continue")?;
    let what = format!("continue the {} in '{}'", operation_name(op), params.repo);
    let cmd = git(ctx, repo);
    let cmd = match op {
        Operation::Merge => cmd.args(["commit", "--no-edit"]),
        _ => cmd.args([operation_name(op), "--continue"]),
    };
    run_stoppable(ctx, repo, cmd, &what)?;
    Ok(Empty {})
}

pub fn abort_operation(ctx: &Ctx, params: RepoParams) -> Result<Empty> {
    let repo = Path::new(&params.repo);
    let op = running(repo, "abort")?;
    git(ctx, repo).args([operation_name(op), "--abort"]).logged().run()?;
    Ok(Empty {})
}

pub fn skip_operation(ctx: &Ctx, params: RepoParams) -> Result<Empty> {
    let repo = Path::new(&params.repo);
    let op = running(repo, "skip")?;
    if op == Operation::Merge {
        return Err(Error::new(format!("Failed to skip the merge in '{}': a merge has nothing to skip.", params.repo)));
    }
    let what = format!("skip a commit of the {} in '{}'", operation_name(op), params.repo);
    run_stoppable(ctx, repo, git(ctx, repo).args([operation_name(op), "--skip"]), &what)?;
    Ok(Empty {})
}

pub fn cherry_pick(ctx: &Ctx, params: RevsParams) -> Result<Empty> {
    apply_commits(ctx, params, "cherry-pick", &["--end-of-options"])
}

pub fn revert(ctx: &Ctx, params: RevsParams) -> Result<Empty> {
    apply_commits(ctx, params, "revert", &["--no-edit", "--end-of-options"])
}

fn apply_commits(ctx: &Ctx, params: RevsParams, command: &str, options: &[&str]) -> Result<Empty> {
    if params.revs.is_empty() {
        return Err(Error::new(format!("Failed to {command} in '{}': no revisions were given.", params.repo)));
    }
    let repo = Path::new(&params.repo);
    let cmd = git(ctx, repo).arg(command).args(options).args(&params.revs);
    run_stoppable(ctx, repo, cmd, &format!("{command} '{}' in '{}'", params.revs.join(" "), params.repo))?;
    Ok(Empty {})
}

pub fn reset(ctx: &Ctx, params: ResetParams) -> Result<Empty> {
    let mode = match params.mode {
        ResetMode::Soft => "--soft",
        ResetMode::Mixed => "--mixed",
        ResetMode::Hard => "--hard",
        ResetMode::Keep => "--keep",
    };
    git(ctx, Path::new(&params.repo)).args(["reset", mode, "--end-of-options", &params.rev, "--"]).logged().run()?;
    Ok(Empty {})
}

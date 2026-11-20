use std::path::Path;

use gitsense_protocol::{
    BranchCreateParams, BranchDeleteParams, BranchParams, BranchRenameParams, Branches, CheckoutParams, CheckoutTarget,
    Empty, LocalBranch, RebaseParams, RemoteBranch, RepoParams, RevParams,
};

use crate::{Ctx, Error, Result, git::git};

pub fn list(ctx: &Ctx, params: RepoParams) -> Result<Branches> {
    let repo = Path::new(&params.repo);
    let remotes = remotes(ctx, repo)?;
    let format = "%(refname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(HEAD)%00%(worktreepath)%00%(symref)";
    let out = git(ctx, repo)
        .args(["for-each-ref", "--sort=refname", &format!("--format={format}"), "refs/heads", "refs/remotes"])
        .run()?;
    let mut branches = Branches { local: Vec::new(), remote: Vec::new() };
    for line in out.stdout_str()?.lines() {
        let fields: Vec<&str> = line.split('\0').collect();
        let [refname, upstream, track, head, worktree, symref] = fields[..] else {
            return Err(Error::new(format!("Failed to parse branch line {line:?}.")));
        };
        if let Some(name) = refname.strip_prefix("refs/heads/") {
            let (ahead, behind) = parse_track(track);
            branches.local.push(LocalBranch {
                name: name.to_string(),
                upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
                upstream_gone: track == "gone",
                ahead,
                behind,
                current: head == "*",
                worktree: (!worktree.is_empty()).then(|| worktree.to_string()),
            });
        } else if let Some(short) = refname.strip_prefix("refs/remotes/") {
            if !symref.is_empty() {
                continue;
            }
            // Remote names may contain slashes, so match the longest known remote.
            let remote = remotes
                .iter()
                .filter(|r| short.strip_prefix(r.as_str()).is_some_and(|rest| rest.starts_with('/')))
                .max_by_key(|r| r.len());
            if let Some(remote) = remote {
                branches
                    .remote
                    .push(RemoteBranch { remote: remote.clone(), name: short[remote.len() + 1..].to_string() });
            }
        }
    }
    Ok(branches)
}

/// Parses `ahead 1, behind 2` from `%(upstream:track,nobracket)`.
fn parse_track(track: &str) -> (u32, u32) {
    let (mut ahead, mut behind) = (0, 0);
    for part in track.split(", ") {
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

pub fn remotes(ctx: &Ctx, repo: &Path) -> Result<Vec<String>> {
    let out = git(ctx, repo).arg("remote").run()?;
    Ok(out.stdout_str()?.lines().map(String::from).collect())
}

pub fn list_remotes(ctx: &Ctx, params: RepoParams) -> Result<Vec<String>> {
    remotes(ctx, Path::new(&params.repo))
}

pub fn checkout(ctx: &Ctx, params: CheckoutParams) -> Result<Empty> {
    let cmd = git(ctx, Path::new(&params.repo)).arg("switch");
    let cmd = match &params.target {
        CheckoutTarget::Branch { name } => cmd.args(["--end-of-options", name]),
        CheckoutTarget::Remote { remote, name } => {
            cmd.args(["--track", "--end-of-options", &format!("{remote}/{name}")])
        }
        CheckoutTarget::Revision { rev } => cmd.args(["--detach", "--end-of-options", rev]),
    };
    cmd.logged().run()?;
    Ok(Empty {})
}

pub fn create(ctx: &Ctx, params: BranchCreateParams) -> Result<Empty> {
    check_name(&params.name)?;
    let cmd = git(ctx, Path::new(&params.repo));
    let cmd = if params.checkout { cmd.args(["switch", "-c"]) } else { cmd.arg("branch") };
    cmd.args([&params.name, "--end-of-options", &params.start]).logged().run()?;
    Ok(Empty {})
}

pub fn rename(ctx: &Ctx, params: BranchRenameParams) -> Result<Empty> {
    check_name(&params.from)?;
    check_name(&params.to)?;
    git(ctx, Path::new(&params.repo)).args(["branch", "-m", &params.from, &params.to]).logged().run()?;
    Ok(Empty {})
}

pub fn delete(ctx: &Ctx, params: BranchDeleteParams) -> Result<Empty> {
    check_name(&params.name)?;
    let repo = Path::new(&params.repo);
    match &params.remote {
        Some(remote) => {
            check_name(remote)?;
            git(ctx, repo).args(["push", remote, "--delete", &format!("refs/heads/{}", params.name)]).logged().run()?
        }
        None => {
            let flag = if params.force { "-D" } else { "-d" };
            git(ctx, repo).args(["branch", flag, &params.name]).logged().run()?
        }
    };
    Ok(Empty {})
}

pub fn update(ctx: &Ctx, params: BranchParams) -> Result<Empty> {
    check_name(&params.branch)?;
    let repo = Path::new(&params.repo);
    let config = |key: &str| -> Result<String> {
        let out =
            git(ctx, repo).args(["config", "--get", &format!("branch.{}.{key}", params.branch)]).run_unchecked()?;
        let value = out.stdout_str()?.trim().to_string();
        if value.is_empty() {
            return Err(Error::new(format!("Failed to update '{}': it has no upstream branch.", params.branch)));
        }
        Ok(value)
    };
    let (remote, merge) = (config("remote")?, config("merge")?);
    // Fetching into the branch fast-forwards it, and refuses when it has diverged.
    git(ctx, repo).args(["fetch", &remote, &format!("{merge}:refs/heads/{}", params.branch)]).logged().run()?;
    Ok(Empty {})
}

pub fn merge(ctx: &Ctx, params: RevParams) -> Result<Empty> {
    git(ctx, Path::new(&params.repo)).args(["merge", "--no-edit", "--end-of-options", &params.rev]).logged().run()?;
    Ok(Empty {})
}

pub fn rebase(ctx: &Ctx, params: RebaseParams) -> Result<Empty> {
    let mut cmd = git(ctx, Path::new(&params.repo)).args(["rebase", "--end-of-options", &params.onto]);
    if let Some(branch) = &params.branch {
        check_name(branch)?;
        cmd = cmd.arg(branch);
    }
    cmd.logged().run()?;
    Ok(Empty {})
}

/// Refuses names git would read as options.
pub fn check_name(name: &str) -> Result<()> {
    if name.is_empty() || name.starts_with('-') {
        return Err(Error::new(format!("Failed to use branch name '{name}': it is empty or starts with '-'.")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_upstream_tracking() {
        assert_eq!(parse_track("ahead 3, behind 12"), (3, 12));
        assert_eq!(parse_track("behind 1"), (0, 1));
        assert_eq!(parse_track("gone"), (0, 0));
        assert_eq!(parse_track(""), (0, 0));
    }
}

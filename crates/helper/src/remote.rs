use std::path::Path;

use gitsense_protocol::{CommitInfo, Empty, PushParams, PushTargetParams, RepoParams};

use crate::branches::check_name;
use crate::{Ctx, Result, git::git, log};

pub fn fetch(ctx: &Ctx, params: RepoParams) -> Result<Empty> {
    git(ctx, Path::new(&params.repo)).args(["fetch", "--all", "--prune"]).logged().run()?;
    Ok(Empty {})
}

pub fn pull(ctx: &Ctx, params: RepoParams) -> Result<Empty> {
    git(ctx, Path::new(&params.repo)).args(["pull", "--autostash", "--no-edit"]).logged().run()?;
    Ok(Empty {})
}

pub fn outgoing(ctx: &Ctx, params: PushTargetParams) -> Result<Vec<CommitInfo>> {
    for name in [&params.branch, &params.remote, &params.remote_branch] {
        check_name(name)?;
    }
    let repo = Path::new(&params.repo);
    let target = format!("refs/remotes/{}/{}", params.remote, params.remote_branch);
    let exists = git(ctx, repo).args(["rev-parse", "--verify", "-q", &target]).run_unchecked()?.success();
    // A new remote branch receives every commit the remote lacks.
    let not = if exists { target } else { format!("--remotes={}", params.remote) };
    log::commits(ctx, repo, &[&format!("refs/heads/{}", params.branch), "--not", &not])
}

pub fn push(ctx: &Ctx, params: PushParams) -> Result<Empty> {
    for name in [&params.branch, &params.remote, &params.remote_branch] {
        check_name(name)?;
    }
    let mut cmd = git(ctx, Path::new(&params.repo)).arg("push");
    if params.set_upstream {
        cmd = cmd.arg("--set-upstream");
    }
    if params.force_with_lease {
        cmd = cmd.arg("--force-with-lease");
    }
    cmd.args([&params.remote, &format!("refs/heads/{}:refs/heads/{}", params.branch, params.remote_branch)])
        .logged()
        .run()?;
    Ok(Empty {})
}

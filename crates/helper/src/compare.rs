//! Comparing two revisions, such as two branches.

use std::path::Path;

use gitsense_protocol::{CommitInfo, CompareParams, ComparedFiles};

use crate::commit::parse_name_status;
use crate::{Ctx, Error, Result, git::git, log};

fn check(params: &CompareParams) -> Result<()> {
    for (name, rev) in [("base", &params.base), ("head", &params.head)] {
        if rev.is_empty() {
            return Err(Error::new(format!("Failed to compare in '{}': the {name} revision is empty.", params.repo)));
        }
    }
    Ok(())
}

pub fn commits(ctx: &Ctx, params: CompareParams) -> Result<Vec<CommitInfo>> {
    check(&params)?;
    let range = format!("{}..{}", params.base, params.head);
    log::commits(ctx, Path::new(&params.repo), &["--topo-order", "--end-of-options", &range])
}

pub fn files(ctx: &Ctx, params: CompareParams) -> Result<ComparedFiles> {
    check(&params)?;
    let repo = Path::new(&params.repo);
    let range = format!("{}...{}", params.base, params.head);
    let out = git(ctx, repo)
        .args(["diff", "-z", "--name-status", "-M", "--no-ext-diff", "--end-of-options", &range, "--"])
        .run()?;
    let files = parse_name_status(out.stdout_str()?)?;
    let merge_base = git(ctx, repo)
        .args(["merge-base", "--end-of-options", &params.base, &params.head])
        .run()?
        .stdout_str()?
        .trim()
        .to_string();
    Ok(ComparedFiles { merge_base, files })
}

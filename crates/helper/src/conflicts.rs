//! Listing and resolving conflicted paths.

use std::collections::BTreeMap;
use std::path::Path;

use gitsense_protocol::{Conflict, ConflictAcceptParams, ConflictSide, Empty, RepoParams};

use crate::files::repo_path;
use crate::{Ctx, Error, Result, git::git};

pub fn list(ctx: &Ctx, params: RepoParams) -> Result<Vec<Conflict>> {
    conflicts(ctx, Path::new(&params.repo))
}

fn conflicts(ctx: &Ctx, repo: &Path) -> Result<Vec<Conflict>> {
    let out = git(ctx, repo).args(["ls-files", "--unmerged", "-z"]).run()?;
    parse_unmerged(out.stdout_str()?)
}

/// Parses `git ls-files --unmerged -z` output: `<mode> <hash> <stage>\t<path>` entries.
fn parse_unmerged(text: &str) -> Result<Vec<Conflict>> {
    let mut by_path: BTreeMap<&str, Conflict> = BTreeMap::new();
    for entry in text.split('\0').filter(|e| !e.is_empty()) {
        let bad = || Error::new(format!("Failed to parse unmerged entry {entry:?}."));
        let (info, path) = entry.split_once('\t').ok_or_else(bad)?;
        let stage = info.rsplit(' ').next().ok_or_else(bad)?;
        let conflict = by_path.entry(path).or_insert_with(|| Conflict {
            path: path.to_string(),
            base: false,
            ours: false,
            theirs: false,
        });
        match stage {
            "1" => conflict.base = true,
            "2" => conflict.ours = true,
            "3" => conflict.theirs = true,
            _ => return Err(bad()),
        }
    }
    Ok(by_path.into_values().collect())
}

pub fn accept(ctx: &Ctx, params: ConflictAcceptParams) -> Result<Empty> {
    let repo = Path::new(&params.repo);
    let (flag, side) = match params.side {
        ConflictSide::Ours => ("--ours", "ours"),
        ConflictSide::Theirs => ("--theirs", "theirs"),
    };
    if params.paths.is_empty() {
        return Err(Error::new(format!("Failed to accept {side} in '{}': no paths were given.", params.repo)));
    }
    let conflicted = conflicts(ctx, repo)?;
    let mut keep = Vec::new();
    let mut delete = Vec::new();
    for path in &params.paths {
        repo_path(&params.repo, path)?;
        let conflict = conflicted.iter().find(|c| &c.path == path).ok_or_else(|| {
            Error::new(format!("Failed to accept {side} for '{path}' in '{}': it is not conflicted.", params.repo))
        })?;
        let exists = if params.side == ConflictSide::Ours { conflict.ours } else { conflict.theirs };
        if exists { keep.push(path) } else { delete.push(path) }
    }
    if !keep.is_empty() {
        git(ctx, repo).args(["checkout", flag, "--"]).args(&keep).logged().run()?;
        git(ctx, repo).args(["add", "--"]).args(&keep).logged().run()?;
    }
    if !delete.is_empty() {
        git(ctx, repo).args(["rm", "--quiet", "--force", "--"]).args(&delete).logged().run()?;
    }
    Ok(Empty {})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_unmerged_stages_per_path() {
        let entries = [
            "100644 aaa 1\ta b.txt",
            "100644 bbb 2\ta b.txt",
            "100644 ccc 3\ta b.txt",
            "100644 ddd 2\tnew.txt",
            "100644 eee 3\tnew.txt",
            "100644 fff 1\tz.txt",
            "100644 ggg 3\tz.txt",
        ];
        let text = entries.join("\0") + "\0";
        let found = parse_unmerged(&text).unwrap();
        let summary: Vec<_> = found.iter().map(|c| (c.path.as_str(), c.base, c.ours, c.theirs)).collect();
        assert_eq!(
            summary,
            [("a b.txt", true, true, true), ("new.txt", false, true, true), ("z.txt", true, false, true)]
        );
    }
}

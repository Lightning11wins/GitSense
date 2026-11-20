use std::path::Path;

use gitsense_protocol::{ChangeKind, FileChange, Operation, RepoParams, RepoStatus};

use crate::repos::GitDirs;
use crate::{Ctx, Error, Result, git::git};

pub fn status(ctx: &Ctx, params: RepoParams) -> Result<RepoStatus> {
    let repo = Path::new(&params.repo);
    let dirs =
        GitDirs::find(repo).ok_or_else(|| Error::new(format!("Failed to find a git repo at '{}'.", params.repo)))?;
    let out = git(ctx, repo).args(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]).run()?;
    let mut status = parse_status(out.stdout_str()?)?;
    status.operation = operation(&dirs.git_dir);
    Ok(status)
}

pub fn operation(git_dir: &Path) -> Option<Operation> {
    let has = |name: &str| git_dir.join(name).exists();
    if has("rebase-merge") || has("rebase-apply") {
        Some(Operation::Rebase)
    } else if has("MERGE_HEAD") {
        Some(Operation::Merge)
    } else if has("CHERRY_PICK_HEAD") {
        Some(Operation::CherryPick)
    } else if has("REVERT_HEAD") {
        Some(Operation::Revert)
    } else {
        None
    }
}

/// Parses `git status --porcelain=v2 --branch -z` output.
fn parse_status(text: &str) -> Result<RepoStatus> {
    let mut status = RepoStatus {
        branch: None,
        head: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        operation: None,
        changes: Vec::new(),
    };
    let bad = |record: &str| Error::new(format!("Failed to parse git status record {record:?}."));
    let mut records = text.split('\0').filter(|r| !r.is_empty());
    while let Some(record) = records.next() {
        let (tag, rest) = record.split_once(' ').ok_or_else(|| bad(record))?;
        match tag {
            "#" => {
                let (key, value) = rest.split_once(' ').unwrap_or((rest, ""));
                match key {
                    "branch.oid" if value != "(initial)" => status.head = Some(value.to_string()),
                    "branch.head" if value != "(detached)" => status.branch = Some(value.to_string()),
                    "branch.upstream" => status.upstream = Some(value.to_string()),
                    "branch.ab" => {
                        let (ahead, behind) = value.split_once(' ').ok_or_else(|| bad(record))?;
                        status.ahead = ahead.trim_start_matches('+').parse().map_err(|_| bad(record))?;
                        status.behind = behind.trim_start_matches('-').parse().map_err(|_| bad(record))?;
                    }
                    _ => {}
                }
            }
            "1" => {
                let fields: Vec<&str> = rest.splitn(8, ' ').collect();
                let [xy, .., path] = fields[..] else { return Err(bad(record)) };
                if fields.len() != 8 {
                    return Err(bad(record));
                }
                if let Some(kind) = ordinary_kind(xy) {
                    status.changes.push(FileChange { path: path.to_string(), orig_path: None, kind });
                }
            }
            "2" => {
                let fields: Vec<&str> = rest.splitn(9, ' ').collect();
                let [.., path] = fields[..] else { return Err(bad(record)) };
                if fields.len() != 9 {
                    return Err(bad(record));
                }
                let orig = records.next().ok_or_else(|| bad(record))?;
                status.changes.push(FileChange {
                    path: path.to_string(),
                    orig_path: Some(orig.to_string()),
                    kind: ChangeKind::Renamed,
                });
            }
            "u" => {
                let fields: Vec<&str> = rest.splitn(10, ' ').collect();
                let [.., path] = fields[..] else { return Err(bad(record)) };
                if fields.len() != 10 {
                    return Err(bad(record));
                }
                status.changes.push(FileChange {
                    path: path.to_string(),
                    orig_path: None,
                    kind: ChangeKind::Conflicted,
                });
            }
            "?" => {
                status.changes.push(FileChange { path: rest.to_string(), orig_path: None, kind: ChangeKind::Untracked })
            }
            "!" => {}
            _ => return Err(bad(record)),
        }
    }
    status.changes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(status)
}

/// The change from HEAD to the working tree for an ordinary entry's XY code,
/// or None when the working tree matches HEAD.
fn ordinary_kind(xy: &str) -> Option<ChangeKind> {
    let mut chars = xy.chars();
    let (x, y) = (chars.next()?, chars.next()?);
    match (x, y) {
        ('A', 'D') => None,
        ('A', _) | (_, 'A') => Some(ChangeKind::Added),
        ('D', _) | (_, 'D') => Some(ChangeKind::Deleted),
        _ => Some(ChangeKind::Modified),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_headers_and_changes() {
        let text = "# branch.oid 1111111111111111111111111111111111111111\0\
            # branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -3\0\
            1 .M N... 100644 100644 100644 aaaa bbbb src/a file.rs\0\
            2 R. N... 100644 100644 100644 aaaa bbbb R100 new.rs\0old.rs\0\
            u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.rs\0\
            ? notes.txt\0";
        let status = parse_status(text).unwrap();
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!((status.ahead, status.behind), (2, 3));
        let changes: Vec<_> = status.changes.iter().map(|c| (c.path.as_str(), c.kind)).collect();
        assert_eq!(
            changes,
            [
                ("conflict.rs", ChangeKind::Conflicted),
                ("new.rs", ChangeKind::Renamed),
                ("notes.txt", ChangeKind::Untracked),
                ("src/a file.rs", ChangeKind::Modified),
            ]
        );
        assert_eq!(status.changes[1].orig_path.as_deref(), Some("old.rs"));
    }

    #[test]
    fn parses_unborn_detached_head() {
        let status = parse_status("# branch.oid (initial)\0# branch.head (detached)\0").unwrap();
        assert_eq!((status.head, status.branch), (None, None));
    }
}

use std::path::Path;

use gitsense_protocol::{CommitInfo, DiffFilesParams, FileChange, LogCommit, LogParams, LogRef, RefKind};

use crate::commit::parse_name_status;
use crate::files::repo_path;
use crate::{Ctx, Error, Result, git::git};

const FORMAT: &str = "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s";

/// Lists commits for `git log` revision arguments, newest first.
pub fn commits(ctx: &Ctx, repo: &Path, revs: &[&str]) -> Result<Vec<CommitInfo>> {
    let out = git(ctx, repo).args(["log", "-z", FORMAT]).args(revs).arg("--").run()?;
    parse(out.stdout_str()?)
}

const LOG_FORMAT: &str = "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%s%x00%D";

pub fn log(ctx: &Ctx, params: LogParams) -> Result<Vec<LogCommit>> {
    let repo = Path::new(&params.repo);
    for path in &params.paths {
        repo_path(&params.repo, path)?;
    }
    let mut filters = vec!["--fixed-strings".to_string(), "--regexp-ignore-case".to_string()];
    if let Some(author) = &params.author {
        filters.push(format!("--author={author}"));
    }
    if let Some(since) = params.since {
        filters.push(format!("--since=@{since}"));
    }
    if let Some(until) = params.until {
        filters.push(format!("--until=@{until}"));
    }
    let query = |extra: &[String], revs: &[String]| -> Result<Vec<LogCommit>> {
        let mut cmd = git(ctx, repo).args(["log", "-z", "--date-order", "--decorate=full", LOG_FORMAT]).args(&filters);
        cmd = cmd.args(extra);
        if revs.is_empty() {
            cmd = cmd.args(["--branches", "--remotes", "--tags", "HEAD"]);
        } else {
            cmd = cmd.arg("--end-of-options").args(revs);
        }
        parse_log(cmd.arg("--").args(&params.paths).run()?.stdout_str()?)
    };
    let page = [format!("--skip={}", params.skip), format!("--max-count={}", params.limit)];
    let Some(text) = params.text.as_deref().filter(|t| !t.is_empty()) else {
        return query(&page, &params.revs);
    };
    let mut commits = query(&[&page[..], &[format!("--grep={text}")]].concat(), &params.revs)?;
    // A hash prefix finds its commit too, at the top of the first page.
    if params.skip == 0 && text.len() >= 4 && text.chars().all(|c| c.is_ascii_hexdigit()) {
        let found = git(ctx, repo)
            .args(["rev-parse", "--verify", "-q", "--end-of-options", &format!("{text}^{{commit}}")])
            .run_unchecked()?;
        if found.success() {
            let hash = found.stdout_str()?.trim().to_string();
            if !commits.iter().any(|c| c.hash == hash) {
                commits.splice(0..0, query(&["--no-walk".into()], &[hash])?);
            }
        }
    }
    Ok(commits)
}

pub fn diff_files(ctx: &Ctx, params: DiffFilesParams) -> Result<Vec<FileChange>> {
    let repo = Path::new(&params.repo);
    let from = match params.from {
        Some(from) => from,
        None => git(ctx, repo)
            .args(["hash-object", "-t", "tree", "--stdin"])
            .stdin(String::new())
            .run()?
            .stdout_str()?
            .trim()
            .to_string(),
    };
    let out = git(ctx, repo)
        .args(["diff", "--no-ext-diff", "-z", "--name-status", "-M", "--end-of-options", &from, &params.to, "--"])
        .run()?;
    parse_name_status(out.stdout_str()?)
}

fn parse_log(text: &str) -> Result<Vec<LogCommit>> {
    let fields: Vec<&str> = text.split('\0').collect();
    let mut commits = Vec::new();
    for chunk in fields.chunks(8) {
        let [hash, parents, name, email, author_time, commit_time, subject, refs] = chunk else {
            if chunk.iter().all(|f| f.is_empty()) {
                break;
            }
            return Err(Error::new(format!("Failed to parse log fields {chunk:?}.")));
        };
        let mut head = false;
        let mut labels = Vec::new();
        for decoration in refs.split(", ").filter(|d| !d.is_empty()) {
            let full = match decoration.strip_prefix("HEAD -> ") {
                Some(rest) => {
                    head = true;
                    rest
                }
                None if decoration == "HEAD" => {
                    head = true;
                    continue;
                }
                None => decoration.strip_prefix("tag: ").unwrap_or(decoration),
            };
            let label = |kind, name: &str| LogRef { kind, name: name.to_string() };
            if let Some(name) = full.strip_prefix("refs/heads/") {
                labels.push(label(RefKind::Local, name));
            } else if let Some(name) = full.strip_prefix("refs/remotes/") {
                // `origin/HEAD` only repeats the remote's default branch.
                if !name.ends_with("/HEAD") {
                    labels.push(label(RefKind::Remote, name));
                }
            } else if let Some(name) = full.strip_prefix("refs/tags/") {
                labels.push(label(RefKind::Tag, name));
            }
        }
        commits.push(LogCommit {
            hash: hash.trim_start_matches('\n').to_string(),
            parents: parents.split_whitespace().map(String::from).collect(),
            author_name: name.to_string(),
            author_email: email.to_string(),
            author_time: parse_time(author_time)?,
            commit_time: parse_time(commit_time)?,
            subject: subject.to_string(),
            head,
            refs: labels,
        });
    }
    Ok(commits)
}

fn parse_time(time: &str) -> Result<i64> {
    time.parse().map_err(|_| Error::new(format!("Failed to parse commit time {time:?}.")))
}

fn parse(text: &str) -> Result<Vec<CommitInfo>> {
    let fields: Vec<&str> = text.split('\0').collect();
    let mut commits = Vec::new();
    for chunk in fields.chunks(6) {
        let [hash, parents, name, email, time, subject] = chunk else {
            if chunk.iter().all(|f| f.is_empty()) {
                break;
            }
            return Err(Error::new(format!("Failed to parse log fields {chunk:?}.")));
        };
        commits.push(CommitInfo {
            hash: hash.trim_start_matches('\n').to_string(),
            parents: parents.split_whitespace().map(String::from).collect(),
            author_name: name.to_string(),
            author_email: email.to_string(),
            author_time: parse_time(time)?,
            subject: subject.to_string(),
        });
    }
    Ok(commits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_commits() {
        let fields = ["aaa", "bbb ccc", "Ann", "ann@example.com", "1700000000", "Merge things"];
        let more = ["bbb", "", "Bob", "bob@example.com", "1600000000", "Start", ""];
        let text = [&fields[..], &more[..]].concat().join("\0");
        let commits = parse(&text).unwrap();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].parents, ["bbb", "ccc"]);
        assert_eq!(commits[1].parents, Vec::<String>::new());
        assert_eq!((commits[1].author_time, commits[1].subject.as_str()), (1600000000, "Start"));
    }
}

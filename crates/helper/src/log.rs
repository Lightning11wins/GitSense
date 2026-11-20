use std::path::Path;

use gitsense_protocol::CommitInfo;

use crate::{Ctx, Error, Result, git::git};

const FORMAT: &str = "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s";

/// Lists commits for `git log` revision arguments, newest first.
pub fn commits(ctx: &Ctx, repo: &Path, revs: &[&str]) -> Result<Vec<CommitInfo>> {
    let out = git(ctx, repo).args(["log", "-z", FORMAT]).args(revs).arg("--").run()?;
    parse(out.stdout_str()?)
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
            author_time: time.parse().map_err(|_| Error::new(format!("Failed to parse commit time {time:?}.")))?,
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

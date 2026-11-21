//! Blame of working-tree files.

use std::collections::HashMap;
use std::path::Path;

use gitsense_protocol::{BlameCommit, BlameParams, BlameResult};

use crate::files::repo_path;
use crate::{Ctx, Error, Result, git::git};

pub fn blame(ctx: &Ctx, params: BlameParams) -> Result<BlameResult> {
    repo_path(&params.repo, &params.path)?;
    let out = git(ctx, Path::new(&params.repo)).args(["blame", "--porcelain", "--", &params.path]).run()?;
    parse_porcelain(&out.stdout)
}

/// Parses `git blame --porcelain` output. A commit's details appear once, with its first line.
fn parse_porcelain(output: &[u8]) -> Result<BlameResult> {
    let bad = |line: &str| Error::new(format!("Failed to parse git blame line {line:?}."));
    let mut result = BlameResult { commits: Vec::new(), lines: Vec::new() };
    let mut index_of: HashMap<String, Option<u32>> = HashMap::new();
    let mut current: Option<String> = None;
    for raw in output.split(|&b| b == b'\n') {
        if raw.first() == Some(&b'\t') {
            let hash = current.as_ref().ok_or_else(|| bad("(content before a header)"))?;
            result.lines.push(index_of[hash]);
            continue;
        }
        let line = String::from_utf8_lossy(raw);
        let (key, value) = line.split_once(' ').unwrap_or((&line, ""));
        let is_header = key.len() >= 40 && key.bytes().all(|b| b.is_ascii_hexdigit()) && value.split(' ').count() >= 2;
        if is_header {
            if !index_of.contains_key(key) {
                let uncommitted = key.bytes().all(|b| b == b'0');
                let index = (!uncommitted).then_some(result.commits.len() as u32);
                if uncommitted {
                    index_of.insert(key.to_string(), None);
                } else {
                    index_of.insert(key.to_string(), index);
                    result.commits.push(BlameCommit {
                        hash: key.to_string(),
                        author_name: String::new(),
                        author_time: 0,
                        summary: String::new(),
                    });
                }
            }
            current = Some(key.to_string());
            continue;
        }
        let Some(&Some(index)) = current.as_ref().map(|h| &index_of[h]) else { continue };
        let commit = &mut result.commits[index as usize];
        match key {
            "author" => commit.author_name = value.to_string(),
            "author-time" => commit.author_time = value.parse().map_err(|_| bad(&line))?,
            "summary" => commit.summary = value.to_string(),
            _ => {}
        }
    }
    Ok(result)
}

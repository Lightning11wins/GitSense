use std::collections::HashSet;
use std::path::{Path, PathBuf};

use gitsense_protocol::{Empty, IgnoreAddParams, IgnoreFile, PathsParams, RollbackParams};

use crate::error::Context;
use crate::files::repo_path;
use crate::repos::GitDirs;
use crate::{Ctx, Error, Result, git::git};

pub fn rollback(ctx: &Ctx, params: RollbackParams) -> Result<Empty> {
    let repo = Path::new(&params.repo);
    for path in &params.paths {
        repo_path(&params.repo, path)?;
    }
    let in_head = head_paths(ctx, repo, &params.paths)?;
    let (tracked, added): (Vec<&String>, Vec<&String>) = params.paths.iter().partition(|p| in_head.contains(*p));
    if !added.is_empty() {
        git(ctx, repo).args(["rm", "--cached", "-q", "--ignore-unmatch", "--"]).args(&added).logged().run()?;
        if params.delete_added {
            delete(&params.repo, &added)?;
        }
    }
    if !tracked.is_empty() {
        git(ctx, repo)
            .args(["restore", "--source=HEAD", "--staged", "--worktree", "--"])
            .args(tracked)
            .logged()
            .run()?;
    }
    Ok(Empty {})
}

pub fn add(ctx: &Ctx, params: PathsParams) -> Result<Empty> {
    for path in &params.paths {
        repo_path(&params.repo, path)?;
    }
    git(ctx, Path::new(&params.repo)).args(["add", "--"]).args(&params.paths).logged().run()?;
    Ok(Empty {})
}

pub fn delete_files(_: &Ctx, params: PathsParams) -> Result<Empty> {
    delete(&params.repo, &params.paths)?;
    Ok(Empty {})
}

pub fn ignore_targets(_: &Ctx, params: PathsParams) -> Result<Vec<IgnoreFile>> {
    let mut common: Option<Vec<&str>> = None;
    for path in &params.paths {
        repo_path(&params.repo, path)?;
        let mut dirs: Vec<&str> = path.split('/').collect();
        dirs.pop();
        common = Some(match common {
            None => dirs,
            Some(prev) => prev.iter().zip(&dirs).take_while(|(a, b)| a == b).map(|(a, _)| *a).collect(),
        });
    }
    let common = common.unwrap_or_default();
    let mut targets = vec![IgnoreFile::Gitignore { dir: String::new() }];
    for depth in 1..=common.len() {
        let dir = common[..depth].join("/");
        if Path::new(&params.repo).join(&dir).join(".gitignore").is_file() {
            targets.push(IgnoreFile::Gitignore { dir });
        }
    }
    targets.push(IgnoreFile::Exclude);
    Ok(targets)
}

pub fn ignore_add(_: &Ctx, params: IgnoreAddParams) -> Result<Empty> {
    let (file, dir) = match &params.file {
        IgnoreFile::Gitignore { dir } if dir.is_empty() => (Path::new(&params.repo).join(".gitignore"), ""),
        IgnoreFile::Gitignore { dir } => (repo_path(&params.repo, &format!("{dir}/.gitignore"))?, dir.as_str()),
        IgnoreFile::Exclude => {
            let dirs = GitDirs::find(Path::new(&params.repo))
                .ok_or_else(|| Error::new(format!("Failed to find a git repo at '{}'.", params.repo)))?;
            let info = dirs.common_dir.join("info");
            std::fs::create_dir_all(&info).context(|| format!("Failed to create '{}'", info.display()))?;
            (info.join("exclude"), "")
        }
    };
    let mut patterns = Vec::new();
    for path in &params.paths {
        repo_path(&params.repo, path)?;
        let rel =
            if dir.is_empty() { Some(path.as_str()) } else { path.strip_prefix(dir).and_then(|r| r.strip_prefix('/')) };
        let rel = rel.ok_or_else(|| Error::new(format!("Failed to ignore '{path}': it is not inside '{dir}'.")))?;
        patterns.push(pattern(rel));
    }
    append_lines(&file, &patterns)?;
    Ok(Empty {})
}

/// An ignore pattern matching exactly `rel`, relative to the ignore file's dir.
fn pattern(rel: &str) -> String {
    let mut out = String::from("/");
    for ch in rel.chars() {
        if matches!(ch, '\\' | '*' | '?' | '[') {
            out.push('\\');
        }
        out.push(ch);
    }
    let spaces = out.len() - out.trim_end_matches(' ').len();
    out.truncate(out.len() - spaces);
    out.push_str(&"\\ ".repeat(spaces));
    out
}

/// Appends the lines missing from a file, creating it if needed.
fn append_lines(file: &PathBuf, lines: &[String]) -> Result<()> {
    let mut text = match std::fs::read_to_string(file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(Error::new(format!("Failed to read '{}': {e}", file.display()))),
    };
    let existing: HashSet<String> = text.lines().map(String::from).collect();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    for line in lines {
        if !existing.contains(line) {
            text.push_str(line);
            text.push('\n');
        }
    }
    std::fs::write(file, text).context(|| format!("Failed to write '{}'", file.display()))
}

/// The given paths that are in HEAD; none before the first commit.
pub fn head_paths(ctx: &Ctx, repo: &Path, paths: &[String]) -> Result<HashSet<String>> {
    if paths.is_empty() || !git(ctx, repo).args(["rev-parse", "--verify", "-q", "HEAD"]).run_unchecked()?.success() {
        return Ok(HashSet::new());
    }
    let out =
        git(ctx, repo).args(["ls-tree", "-r", "-z", "--name-only", "--full-tree", "HEAD", "--"]).args(paths).run()?;
    Ok(out.stdout_str()?.split('\0').filter(|p| !p.is_empty()).map(String::from).collect())
}

fn delete(repo: &str, paths: &[impl AsRef<str>]) -> Result<()> {
    for path in paths {
        let full = repo_path(repo, path.as_ref())?;
        match std::fs::remove_file(&full) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err(Error::new(format!("Failed to delete '{}': {e}", full.display())));
            }
            _ => {}
        }
    }
    Ok(())
}

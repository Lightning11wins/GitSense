use std::path::{Path, PathBuf};

use gitsense_protocol::{Empty, PathParams, Repo, SetHiddenParams};
use serde::{Deserialize, Serialize};

use crate::error::Context;
use crate::{Ctx, Error, Result, git::git};

const MAX_SCAN_DEPTH: usize = 12;

/// The repo list, saved as `repos.json` in the state dir.
pub struct Store {
    file: PathBuf,
    data: StoredRepos,
}

#[derive(Serialize, Deserialize)]
struct StoredRepos {
    scanned: bool,
    /// Dir names the scan never descends into.
    skip_dirs: Vec<String>,
    repos: Vec<StoredRepo>,
}

impl Default for StoredRepos {
    fn default() -> Self {
        let skip_dirs = [
            "node_modules",
            ".cache",
            ".npm",
            ".pnpm-store",
            ".cargo",
            ".rustup",
            ".nvm",
            ".local",
            ".m2",
            ".gradle",
            "target",
            "__pycache__",
            ".venv",
            "venv",
            "snap",
            ".Trash",
        ];
        Self { scanned: false, skip_dirs: skip_dirs.map(String::from).to_vec(), repos: Vec::new() }
    }
}

#[derive(Serialize, Deserialize, Clone)]
struct StoredRepo {
    path: String,
    hidden: bool,
    /// Added by the user, so kept even when a scan doesn't find it.
    manual: bool,
}

impl Store {
    pub fn load(paths: &crate::paths::Paths) -> Self {
        let file = paths.state.join("repos.json");
        let data = match std::fs::read(&file) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                eprintln!("gitsense-helper: Failed to parse '{}', starting fresh: {e}", file.display());
                StoredRepos::default()
            }),
            Err(_) => StoredRepos::default(),
        };
        Self { file, data }
    }

    fn save(&self) -> Result<()> {
        let dir = self.file.parent().expect("repos.json has a parent dir");
        std::fs::create_dir_all(dir).context(|| format!("Failed to create '{}'", dir.display()))?;
        let tmp = self.file.with_extension("json.tmp");
        let json = serde_json::to_vec_pretty(&self.data).expect("Failed to serialize repos");
        std::fs::write(&tmp, json).context(|| format!("Failed to write '{}'", tmp.display()))?;
        std::fs::rename(&tmp, &self.file).context(|| format!("Failed to write '{}'", self.file.display()))
    }

    /// Repos that still exist, in path order.
    fn repos(&self) -> Vec<Repo> {
        let mut repos: Vec<Repo> = self
            .data
            .repos
            .iter()
            .filter_map(|stored| {
                let info = GitDirs::find(Path::new(&stored.path))?;
                Some(Repo {
                    path: stored.path.clone(),
                    common_dir: info.common_dir.display().to_string(),
                    is_worktree: info.is_worktree,
                    hidden: stored.hidden,
                })
            })
            .collect();
        repos.sort_by(|a, b| a.path.cmp(&b.path));
        repos
    }
}

pub fn list(ctx: &Ctx, _: Empty) -> Result<Vec<Repo>> {
    let scanned = ctx.repos.lock().unwrap().data.scanned;
    if !scanned {
        return scan(ctx, Empty {});
    }
    let repos = ctx.repos.lock().unwrap().repos();
    crate::watch::update(ctx, &repos);
    Ok(repos)
}

pub fn scan(ctx: &Ctx, _: Empty) -> Result<Vec<Repo>> {
    let skip_dirs = ctx.repos.lock().unwrap().data.skip_dirs.clone();
    let found = find_repos(&ctx.paths.home, &skip_dirs);
    let repos = {
        let mut store = ctx.repos.lock().unwrap();
        let old = std::mem::take(&mut store.data.repos);
        let mut merged: Vec<StoredRepo> = found
            .into_iter()
            .map(|path| {
                let path = path.display().to_string();
                let hidden = old.iter().any(|r| r.path == path && r.hidden);
                StoredRepo { path, hidden, manual: false }
            })
            .collect();
        for repo in old {
            if repo.manual && !merged.iter().any(|r| r.path == repo.path) {
                merged.push(repo);
            }
        }
        store.data.repos = merged;
        store.data.scanned = true;
        store.save()?;
        store.repos()
    };
    crate::watch::update(ctx, &repos);
    Ok(repos)
}

pub fn add(ctx: &Ctx, params: PathParams) -> Result<Repo> {
    let dir = Path::new(&params.path);
    if !dir.is_dir() {
        return Err(Error::new(format!("Failed to add repo: '{}' is not a dir.", params.path)));
    }
    let out = git(ctx, dir).args(["rev-parse", "--show-toplevel"]).run()?;
    let root = out.stdout_str()?.trim().to_string();
    let repos = {
        let mut store = ctx.repos.lock().unwrap();
        match store.data.repos.iter_mut().find(|r| r.path == root) {
            Some(repo) => {
                repo.manual = true;
                repo.hidden = false;
            }
            None => store.data.repos.push(StoredRepo { path: root.clone(), hidden: false, manual: true }),
        }
        store.save()?;
        store.repos()
    };
    crate::watch::update(ctx, &repos);
    repos
        .into_iter()
        .find(|r| r.path == root)
        .ok_or_else(|| Error::new(format!("Failed to add repo: no git dir found at '{root}'.")))
}

pub fn set_hidden(ctx: &Ctx, params: SetHiddenParams) -> Result<Empty> {
    let repos = {
        let mut store = ctx.repos.lock().unwrap();
        let repo = store
            .data
            .repos
            .iter_mut()
            .find(|r| r.path == params.repo)
            .ok_or_else(|| Error::new(format!("Failed to find repo '{}'.", params.repo)))?;
        repo.hidden = params.hidden;
        store.save()?;
        store.repos()
    };
    crate::watch::update(ctx, &repos);
    Ok(Empty {})
}

/// Finds working trees under `root`, including nested ones, in path order.
fn find_repos(root: &Path, skip_dirs: &[String]) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut is_repo = false;
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name == ".git" {
                is_repo = true;
                continue;
            }
            let Ok(file_type) = entry.file_type() else { continue };
            let skipped = skip_dirs.iter().any(|s| name == s.as_str());
            if file_type.is_dir() && !skipped && depth < MAX_SCAN_DEPTH {
                stack.push((entry.path(), depth + 1));
            }
        }
        if is_repo && GitDirs::find(&dir).is_some() {
            found.push(dir);
        }
    }
    found.sort();
    found
}

/// A working tree's git dirs, read from its `.git` entry without running git.
pub struct GitDirs {
    /// This working tree's own git dir (HEAD, index, MERGE_HEAD).
    pub git_dir: PathBuf,
    /// The git dir shared by all worktrees (refs, objects, config).
    pub common_dir: PathBuf,
    pub is_worktree: bool,
}

impl GitDirs {
    pub fn find(work_tree: &Path) -> Option<Self> {
        let dot_git = work_tree.join(".git");
        let meta = std::fs::metadata(&dot_git).ok()?;
        if meta.is_dir() {
            let common_dir = dot_git.canonicalize().unwrap_or_else(|_| dot_git.clone());
            return Some(Self { git_dir: dot_git, common_dir, is_worktree: false });
        }
        let text = std::fs::read_to_string(&dot_git).ok()?;
        let git_dir = work_tree.join(text.strip_prefix("gitdir:")?.trim());
        if !git_dir.is_dir() {
            return None;
        }
        match std::fs::read_to_string(git_dir.join("commondir")) {
            Ok(common) => {
                let common_dir = git_dir.join(common.trim());
                let common_dir = common_dir.canonicalize().unwrap_or(common_dir);
                Some(Self { git_dir, common_dir, is_worktree: true })
            }
            // A submodule: its own git dir, not shared.
            Err(_) => Some(Self { common_dir: git_dir.clone(), git_dir, is_worktree: false }),
        }
    }
}

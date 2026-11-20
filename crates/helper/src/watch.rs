//! Watches repos with inotify and reports `RepoChanged` events.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gitsense_protocol::{Event, Repo};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};

use crate::repos::GitDirs;
use crate::{Ctx, Output, git::Git};

/// Quiet time after the last change before a repo is reported.
const DEBOUNCE: Duration = Duration::from_millis(250);
/// How often repos that couldn't be watched are reported as changed.
const POLL_INTERVAL: Duration = Duration::from_secs(5);
/// Dir names never watched inside a working tree, besides git-ignored dirs.
const SKIP_NAMES: [&str; 2] = [".git", "node_modules"];

/// The running watcher. Dropping it stops watching.
pub struct Watcher {
    repos: Vec<String>,
    _inner: Arc<Mutex<RecommendedWatcher>>,
}

/// Watches exactly the visible repos in `repos`, replacing any earlier watcher.
pub fn update(ctx: &Ctx, repos: &[Repo]) {
    let visible: Vec<String> = repos.iter().filter(|r| !r.hidden).map(|r| r.path.clone()).collect();
    let mut slot = ctx.watcher.lock().unwrap();
    if slot.as_ref().is_some_and(|w| w.repos == visible) {
        return;
    }
    *slot = None;
    let (tx, rx) = mpsc::channel::<Change>();
    let inner = match notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        // Reads, including our own and git's, are not changes.
        if matches!(event.kind, EventKind::Access(_) | EventKind::Other) {
            return;
        }
        let created = matches!(event.kind, EventKind::Create(_));
        for path in event.paths {
            let _ = tx.send(Change { path, created });
        }
    }) {
        Ok(w) => Arc::new(Mutex::new(w)),
        Err(e) => {
            ctx.event(Event::Notice {
                text: format!("Failed to start the file watcher: {e}. Changes appear on refresh."),
            });
            return;
        }
    };
    let out = ctx.out.clone();
    let roots = visible.clone();
    let watcher = inner.clone();
    std::thread::spawn(move || run(out, roots, watcher, rx));
    *slot = Some(Watcher { repos: visible, _inner: inner });
}

struct Change {
    path: PathBuf,
    created: bool,
}

struct Root {
    repo: String,
    dirs: Vec<PathBuf>,
}

fn run(out: Output, repos: Vec<String>, watcher: Arc<Mutex<RecommendedWatcher>>, rx: mpsc::Receiver<Change>) {
    let mut roots = Vec::new();
    let mut polled = Vec::new();
    for repo in repos {
        let Some(git_dirs) = GitDirs::find(Path::new(&repo)) else { continue };
        let mut dirs = vec![PathBuf::from(&repo), git_dirs.git_dir.clone(), git_dirs.common_dir.clone()];
        let result = watch_repo(&out, &repo, &git_dirs, &mut watcher.lock().unwrap());
        if let Err(e) = result {
            out.event(Event::Notice {
                text: format!(
                    "Failed to watch '{repo}' ({e}). Checking it every {}s instead.",
                    POLL_INTERVAL.as_secs()
                ),
            });
            polled.push(repo.clone());
        }
        dirs.dedup();
        roots.push(Root { repo, dirs });
    }
    // Longest dirs first, so nested repos win over their parents.
    let mut owners: Vec<(PathBuf, usize)> =
        roots.iter().enumerate().flat_map(|(i, root)| root.dirs.iter().map(move |d| (d.clone(), i))).collect();
    owners.sort_by_key(|(dir, _)| std::cmp::Reverse(dir.as_os_str().len()));

    let mut pending: HashMap<usize, Instant> = HashMap::new();
    let mut next_poll = Instant::now() + POLL_INTERVAL;
    loop {
        let now = Instant::now();
        let mut wake = next_poll;
        for &last in pending.values() {
            wake = wake.min(last + DEBOUNCE);
        }
        match rx.recv_timeout(wake.saturating_duration_since(now)) {
            Ok(Change { path, created }) => {
                if created && path.is_dir() && (!is_inside_git_dir(&path) || is_ref_dir(&path)) {
                    // New dirs need their own watches; errors here only cost live updates.
                    let _ = watch_tree(&path, &[], &mut watcher.lock().unwrap());
                }
                if let Some(&(_, i)) = owners.iter().find(|(dir, _)| path.starts_with(dir)) {
                    pending.insert(i, Instant::now());
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        let now = Instant::now();
        pending.retain(|&i, last| {
            let ready = now >= *last + DEBOUNCE;
            if ready {
                out.event(Event::RepoChanged { repo: roots[i].repo.clone() });
            }
            !ready
        });
        if now >= next_poll {
            for repo in &polled {
                out.event(Event::RepoChanged { repo: repo.clone() });
            }
            next_poll = now + POLL_INTERVAL;
        }
    }
}

fn watch_repo(out: &Output, repo: &str, git_dirs: &GitDirs, watcher: &mut RecommendedWatcher) -> notify::Result<()> {
    watcher.watch(&git_dirs.git_dir, RecursiveMode::NonRecursive)?;
    if git_dirs.common_dir != git_dirs.git_dir {
        watcher.watch(&git_dirs.common_dir, RecursiveMode::NonRecursive)?;
    }
    watch_tree(&git_dirs.common_dir.join("refs"), &[], watcher)?;
    let ignored = ignored_dirs(out, Path::new(repo));
    watch_tree(Path::new(repo), &ignored, watcher)
}

/// Watches `root` and its subdirs, skipping `skip` dirs, nested repos, and [`SKIP_NAMES`].
fn watch_tree(root: &Path, skip: &[PathBuf], watcher: &mut RecommendedWatcher) -> notify::Result<()> {
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        watcher.watch(&dir, RecursiveMode::NonRecursive)?;
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
            let skipped = SKIP_NAMES.iter().any(|n| entry.file_name() == *n) || skip.contains(&path);
            let nested_repo = path.join(".git").exists();
            if is_dir && !skipped && !nested_repo {
                stack.push(path);
            }
        }
    }
    Ok(())
}

/// Top-level git-ignored dirs of a working tree, as absolute paths.
fn ignored_dirs(out: &Output, repo: &Path) -> Vec<PathBuf> {
    let result = Git::new(out.clone(), repo)
        .args(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])
        .run();
    let Ok(output) = result else { return Vec::new() };
    output
        .stdout
        .split(|&b| b == 0)
        .filter_map(|entry| std::str::from_utf8(entry).ok())
        .filter_map(|entry| entry.strip_suffix('/'))
        .map(|dir| repo.join(dir))
        .collect()
}

fn is_inside_git_dir(path: &Path) -> bool {
    path.components().any(|c| c.as_os_str() == ".git")
}

fn is_ref_dir(path: &Path) -> bool {
    path.components().any(|c| c.as_os_str() == "refs")
}

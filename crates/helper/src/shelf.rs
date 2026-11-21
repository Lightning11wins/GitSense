//! The shelf: changes saved as patches and reverted from the working tree.
//!
//! Each entry is two files in `<state>/shelf/`: `<id>.patch`, the changes
//! against the base commit, and `<id>.json`, its metadata including the repo
//! it belongs to. Ids are unique across repos, so repos share the dir without
//! mixing.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use gitsense_protocol::{
    Empty, FileSides, RepoParams, RollbackParams, ShelfCreateParams, ShelfEntry, ShelfFileParams, ShelfIdParams,
    ShelfUnshelveParams,
};
use serde::{Deserialize, Serialize};

use crate::commit::index_paths;
use crate::error::Context;
use crate::files::{content, read_object, repo_path};
use crate::git::git;
use crate::patch::{apply_to_tree, apply_to_worktree, changes_diff, head_commit, restrict};
use crate::{Ctx, Error, Result};

#[derive(Serialize, Deserialize)]
struct Stored {
    /// Working tree root of the repo the entry belongs to.
    repo: String,
    entry: ShelfEntry,
}

fn shelf_dir(ctx: &Ctx) -> PathBuf {
    ctx.paths.state.join("shelf")
}

fn json_path(ctx: &Ctx, id: &str) -> PathBuf {
    shelf_dir(ctx).join(format!("{id}.json"))
}

fn patch_path(ctx: &Ctx, id: &str) -> PathBuf {
    shelf_dir(ctx).join(format!("{id}.patch"))
}

pub fn list(ctx: &Ctx, params: RepoParams) -> Result<Vec<ShelfEntry>> {
    let dir = shelf_dir(ctx);
    let reader = match std::fs::read_dir(&dir) {
        Ok(reader) => reader,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(Error::new(format!("Failed to read '{}': {e}", dir.display()))),
    };
    let mut entries = Vec::new();
    for item in reader {
        let path = item.context(|| format!("Failed to read '{}'", dir.display()))?.path();
        if path.extension().is_some_and(|e| e == "json") {
            let stored = read_json(&path)?;
            if stored.repo == params.repo {
                entries.push(stored.entry);
            }
        }
    }
    entries.sort_by(|a, b| b.created.cmp(&a.created).then_with(|| b.id.cmp(&a.id)));
    Ok(entries)
}

pub fn create(ctx: &Ctx, params: ShelfCreateParams) -> Result<ShelfEntry> {
    let repo = Path::new(&params.repo);
    if params.paths.is_empty() {
        return Err(Error::new("Failed to shelve: no files were selected."));
    }
    for path in &params.paths {
        repo_path(&params.repo, path)?;
    }
    let base = head_commit(ctx, repo, "shelve")?;
    let tracked: HashSet<String> = index_paths(ctx, repo, &params.paths)?
        .union(&crate::changes::head_paths(ctx, repo, &params.paths)?)
        .cloned()
        .collect();
    let untracked: Vec<&str> = params.paths.iter().filter(|p| !tracked.contains(*p)).map(String::as_str).collect();
    if !untracked.is_empty() {
        return Err(Error::new(format!("Failed to shelve untracked files: {}", untracked.join(", "))));
    }
    let unmerged = git(ctx, repo).args(["ls-files", "-u", "-z", "--"]).args(&params.paths).run()?;
    if !unmerged.stdout.is_empty() {
        return Err(Error::new(format!(
            "Failed to shelve files with unresolved conflicts: {}",
            String::from_utf8_lossy(&unmerged.stdout)
                .split('\0')
                .filter_map(|e| e.split_once('\t'))
                .map(|(_, p)| p)
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    let diff = changes_diff(ctx, &params.repo, &base, &params.paths)?;
    if diff.files.is_empty() {
        return Err(Error::new(format!("Failed to shelve: no changes in {}", params.paths.join(", "))));
    }
    let entry = ShelfEntry { id: new_id(), message: params.message, created: now(), base, files: diff.files };
    store(ctx, &params.repo, &entry, &diff.patch)?;
    let reverted = crate::changes::rollback(
        ctx,
        RollbackParams { repo: params.repo.clone(), paths: params.paths, delete_added: true },
    );
    if let Err(e) = reverted {
        return Err(Error::new(format!(
            "Failed to revert shelved files (the shelf entry '{}' was kept): {e}",
            entry.id
        )));
    }
    Ok(entry)
}

pub fn file(ctx: &Ctx, params: ShelfFileParams) -> Result<FileSides> {
    let (stored, patch) = load(ctx, &params.repo, &params.id)?;
    let change = stored
        .entry
        .files
        .iter()
        .find(|f| f.path == params.path)
        .ok_or_else(|| Error::new(format!("Failed to find '{}' in shelf entry '{}'.", params.path, params.id)))?;
    let applied = apply_to_tree(ctx, Path::new(&params.repo), &stored.entry.base, &patch, false)?;
    let before_path = change.orig_path.as_deref().unwrap_or(&change.path);
    Ok(FileSides {
        before: content(read_object(ctx, &params.repo, &format!("{}:{before_path}", stored.entry.base))?),
        after: content(read_object(ctx, &params.repo, &format!("{}:{}", applied.tree, change.path))?),
    })
}

pub fn unshelve(ctx: &Ctx, params: ShelfUnshelveParams) -> Result<Empty> {
    let repo = Path::new(&params.repo);
    let (mut stored, patch) = load(ctx, &params.repo, &params.id)?;
    let base = stored.entry.base.clone();
    let action = format!("unshelve '{}'", params.id);
    let selected = match &params.paths {
        None => stored.entry.files.clone(),
        Some(paths) if paths.is_empty() => {
            return Err(Error::new(format!("Failed to {action}: no files were selected.")));
        }
        Some(paths) => paths
            .iter()
            .map(|path| {
                let found = stored.entry.files.iter().find(|f| f.path == *path);
                found
                    .cloned()
                    .ok_or_else(|| Error::new(format!("Failed to find '{path}' in shelf entry '{}'.", params.id)))
            })
            .collect::<Result<Vec<_>>>()?,
    };
    let remaining: Vec<_> =
        stored.entry.files.iter().filter(|f| !selected.iter().any(|s| s.path == f.path)).cloned().collect();
    if remaining.is_empty() {
        apply_to_worktree(ctx, &params.repo, &patch, &action)?;
        if !params.keep {
            remove(ctx, &params.id)?;
        }
        return Ok(Empty {});
    }
    let subset = restrict(ctx, repo, &base, &patch, &change_paths(&selected))?;
    apply_to_worktree(ctx, &params.repo, &subset, &action)?;
    if !params.keep {
        let rest = restrict(ctx, repo, &base, &patch, &change_paths(&remaining))?;
        stored.entry.files = remaining;
        store(ctx, &params.repo, &stored.entry, &rest)?;
    }
    Ok(Empty {})
}

pub fn delete(ctx: &Ctx, params: ShelfIdParams) -> Result<Empty> {
    load(ctx, &params.repo, &params.id)?;
    remove(ctx, &params.id)?;
    Ok(Empty {})
}

/// Paths of changes, including the old paths of renames.
fn change_paths(files: &[gitsense_protocol::FileChange]) -> Vec<String> {
    files.iter().flat_map(|f| [Some(f.path.clone()), f.orig_path.clone()]).flatten().collect()
}

fn new_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
    format!("{millis:x}-{:x}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed))
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

fn check_id(id: &str) -> Result<()> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(Error::new(format!("Failed to use shelf id '{id}': it may only hold letters, digits, and '-'.")));
    }
    Ok(())
}

fn read_json(path: &Path) -> Result<Stored> {
    let bytes = std::fs::read(path).context(|| format!("Failed to read '{}'", path.display()))?;
    serde_json::from_slice(&bytes).context(|| format!("Failed to parse '{}'", path.display()))
}

/// Reads an entry of `repo` and its patch.
fn load(ctx: &Ctx, repo: &str, id: &str) -> Result<(Stored, Vec<u8>)> {
    check_id(id)?;
    let json = json_path(ctx, id);
    if !json.exists() {
        return Err(Error::new(format!("Failed to find shelf entry '{id}' in '{repo}'.")));
    }
    let stored = read_json(&json)?;
    if stored.repo != repo {
        return Err(Error::new(format!("Failed to find shelf entry '{id}' in '{repo}'.")));
    }
    let path = patch_path(ctx, id);
    let patch = std::fs::read(&path).context(|| format!("Failed to read '{}'", path.display()))?;
    Ok((stored, patch))
}

/// Writes an entry. The patch goes first, so a listed entry always has one.
fn store(ctx: &Ctx, repo: &str, entry: &ShelfEntry, patch: &[u8]) -> Result<()> {
    let dir = shelf_dir(ctx);
    std::fs::create_dir_all(&dir).context(|| format!("Failed to create '{}'", dir.display()))?;
    write_atomic(&patch_path(ctx, &entry.id), patch)?;
    let json = serde_json::to_vec_pretty(&Stored { repo: repo.to_string(), entry: entry.clone() })
        .expect("Failed to serialize a shelf entry");
    write_atomic(&json_path(ctx, &entry.id), &json)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).context(|| format!("Failed to write '{}'", tmp.display()))?;
    std::fs::rename(&tmp, path).context(|| format!("Failed to write '{}'", path.display()))
}

/// Deletes an entry. The listing file goes first, so a half-deleted entry never lists.
fn remove(ctx: &Ctx, id: &str) -> Result<()> {
    for path in [json_path(ctx, id), patch_path(ctx, id)] {
        std::fs::remove_file(&path).context(|| format!("Failed to delete '{}'", path.display()))?;
    }
    Ok(())
}

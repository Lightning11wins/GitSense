//! Changelists: named groups of changed files, kept per repo in the helper's state dir.
//!
//! Stored as `changelists.json`, keyed by repo path. Each repo has an ordered list of named lists, the
//! first being the default list, and the name of the active list. A path is in at most one list; changed
//! paths in none are in the active list.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use gitsense_protocol::{
    Changelist, ChangelistDeleteParams, ChangelistParams, ChangelistPathsParams, ChangelistRenameParams, Changelists,
    RepoParams,
};
use serde::{Deserialize, Serialize};

use crate::error::Context;
use crate::files::repo_path;
use crate::repos::GitDirs;
use crate::{Ctx, Error, Result, status};

/// Name of the default list in a repo with no stored changelists.
const DEFAULT_NAME: &str = "Changes";

/// Serializes read-modify-write cycles of the file.
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Default)]
struct Stored {
    repos: BTreeMap<String, RepoLists>,
}

#[derive(Serialize, Deserialize)]
struct RepoLists {
    active: String,
    /// Never empty. The first list is the default one.
    lists: Vec<StoredList>,
}

#[derive(Serialize, Deserialize)]
struct StoredList {
    name: String,
    paths: BTreeSet<String>,
}

impl Default for RepoLists {
    fn default() -> Self {
        Self {
            active: DEFAULT_NAME.into(),
            lists: vec![StoredList { name: DEFAULT_NAME.into(), paths: BTreeSet::new() }],
        }
    }
}

impl RepoLists {
    fn index(&self, name: &str) -> Result<usize> {
        self.lists
            .iter()
            .position(|l| l.name == name)
            .ok_or_else(|| Error::new(format!("Failed to find changelist '{name}'.")))
    }

    fn check_new_name(&self, name: &str) -> Result<()> {
        if name.trim().is_empty() {
            return Err(Error::new(format!("Failed to name a changelist {name:?}: the name is empty.")));
        }
        if self.lists.iter().any(|l| l.name == name) {
            return Err(Error::new(format!("Failed to name a changelist '{name}': that name is already used.")));
        }
        Ok(())
    }

    fn view(&self) -> Changelists {
        Changelists {
            active: self.active.clone(),
            lists: self
                .lists
                .iter()
                .enumerate()
                .map(|(i, l)| Changelist {
                    name: l.name.clone(),
                    is_default: i == 0,
                    paths: l.paths.iter().cloned().collect(),
                })
                .collect(),
        }
    }
}

fn file(ctx: &Ctx) -> PathBuf {
    ctx.paths.state.join("changelists.json")
}

fn load(ctx: &Ctx) -> Result<Stored> {
    let file = file(ctx);
    let bytes = match std::fs::read(&file) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Stored::default()),
        Err(e) => return Err(Error::new(format!("Failed to read '{}': {e}", file.display()))),
    };
    let stored: Stored = serde_json::from_slice(&bytes).context(|| format!("Failed to parse '{}'", file.display()))?;
    for (repo, lists) in &stored.repos {
        if lists.lists.is_empty() || !lists.lists.iter().any(|l| l.name == lists.active) {
            return Err(Error::new(format!(
                "Failed to use the changelists of '{repo}' in '{}': they are inconsistent.",
                file.display()
            )));
        }
    }
    Ok(stored)
}

fn save(ctx: &Ctx, stored: &Stored) -> Result<()> {
    let file = file(ctx);
    std::fs::create_dir_all(&ctx.paths.state)
        .context(|| format!("Failed to create '{}'", ctx.paths.state.display()))?;
    let tmp = file.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(stored).expect("Failed to serialize changelists");
    std::fs::write(&tmp, json).context(|| format!("Failed to write '{}'", tmp.display()))?;
    std::fs::rename(&tmp, &file).context(|| format!("Failed to write '{}'", file.display()))
}

/// Applies `change` to a repo's lists and saves them. Nothing is saved when it fails.
fn update(ctx: &Ctx, repo: &str, change: impl FnOnce(&mut RepoLists) -> Result<()>) -> Result<Changelists> {
    if GitDirs::find(Path::new(repo)).is_none() {
        return Err(Error::new(format!("Failed to find a git repo at '{repo}'.")));
    }
    let _guard = LOCK.lock().unwrap();
    let mut stored = load(ctx)?;
    let lists = stored.repos.entry(repo.to_string()).or_default();
    change(lists)?;
    let view = lists.view();
    save(ctx, &stored)?;
    Ok(view)
}

pub fn get(ctx: &Ctx, params: RepoParams) -> Result<Changelists> {
    let changed: BTreeSet<String> = status::status(ctx, params.clone())?
        .changes
        .into_iter()
        .flat_map(|c| [Some(c.path), c.orig_path])
        .flatten()
        .collect();
    let _guard = LOCK.lock().unwrap();
    let mut stored = load(ctx)?;
    let Some(lists) = stored.repos.get_mut(&params.repo) else {
        return Ok(RepoLists::default().view());
    };
    let before: usize = lists.lists.iter().map(|l| l.paths.len()).sum();
    for list in &mut lists.lists {
        list.paths.retain(|p| changed.contains(p));
    }
    let view = lists.view();
    if before != view.lists.iter().map(|l| l.paths.len()).sum::<usize>() {
        save(ctx, &stored)?;
    }
    Ok(view)
}

pub fn create(ctx: &Ctx, params: ChangelistParams) -> Result<Changelists> {
    update(ctx, &params.repo, |lists| {
        lists.check_new_name(&params.name)?;
        lists.lists.push(StoredList { name: params.name, paths: BTreeSet::new() });
        Ok(())
    })
}

pub fn rename(ctx: &Ctx, params: ChangelistRenameParams) -> Result<Changelists> {
    update(ctx, &params.repo, |lists| {
        let index = lists.index(&params.name)?;
        if params.new_name != params.name {
            lists.check_new_name(&params.new_name)?;
        }
        if lists.active == params.name {
            lists.active = params.new_name.clone();
        }
        lists.lists[index].name = params.new_name;
        Ok(())
    })
}

pub fn delete(ctx: &Ctx, params: ChangelistDeleteParams) -> Result<Changelists> {
    update(ctx, &params.repo, |lists| {
        let index = lists.index(&params.name)?;
        if index == 0 {
            return Err(Error::new(format!("Failed to delete changelist '{}': it is the default list.", params.name)));
        }
        let target = match &params.move_to {
            Some(target) => lists.index(target)?,
            None => 0,
        };
        if target == index {
            return Err(Error::new(format!(
                "Failed to delete changelist '{}': its files can't move into it.",
                params.name
            )));
        }
        let removed = lists.lists.remove(index);
        let target = &mut lists.lists[if target > index { target - 1 } else { target }];
        target.paths.extend(removed.paths);
        if lists.active == removed.name {
            lists.active = target.name.clone();
        }
        Ok(())
    })
}

pub fn set_active(ctx: &Ctx, params: ChangelistParams) -> Result<Changelists> {
    update(ctx, &params.repo, |lists| {
        lists.index(&params.name)?;
        lists.active = params.name;
        Ok(())
    })
}

pub fn move_paths(ctx: &Ctx, params: ChangelistPathsParams) -> Result<Changelists> {
    for path in &params.paths {
        repo_path(&params.repo, path)?;
    }
    update(ctx, &params.repo, |lists| {
        let index = lists.index(&params.name)?;
        for list in &mut lists.lists {
            for path in &params.paths {
                list.paths.remove(path);
            }
        }
        lists.lists[index].paths.extend(params.paths);
        Ok(())
    })
}

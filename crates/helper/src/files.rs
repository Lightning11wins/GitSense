use std::path::{Component, Path, PathBuf};

use gitsense_protocol::{Empty, FileContent, FileReadParams, FileVersion, FileWriteParams};

use crate::error::Context;
use crate::{Ctx, Error, Result, git::git};

/// Resolves a repo-relative path, refusing paths that leave the repo.
pub fn repo_path(repo: &str, path: &str) -> Result<PathBuf> {
    let rel = Path::new(path);
    let inside = rel.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    if path.is_empty() || !inside {
        return Err(Error::new(format!("Failed to use path '{path}': it must be relative and inside the repo.")));
    }
    Ok(Path::new(repo).join(rel))
}

pub fn read(ctx: &Ctx, params: FileReadParams) -> Result<FileContent> {
    let full = repo_path(&params.repo, &params.path)?;
    let bytes = match params.version {
        FileVersion::WorkingTree => match std::fs::read(&full) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(Error::new(format!("Failed to read '{}': {e}", full.display()))),
        },
        FileVersion::Revision { rev } => read_object(ctx, &params.repo, &format!("{rev}:{}", params.path))?,
        FileVersion::Index { stage } => read_object(ctx, &params.repo, &format!(":{stage}:{}", params.path))?,
    };
    Ok(content(bytes))
}

pub fn write(_: &Ctx, params: FileWriteParams) -> Result<Empty> {
    let full = repo_path(&params.repo, &params.path)?;
    std::fs::write(&full, params.text).context(|| format!("Failed to write '{}'", full.display()))?;
    Ok(Empty {})
}

/// Reads a blob by object name, or None when it doesn't exist.
pub fn read_object(ctx: &Ctx, repo: &str, object: &str) -> Result<Option<Vec<u8>>> {
    if object.contains('\n') {
        return Err(Error::new(format!("Failed to read {object:?}: object names cannot contain newlines.")));
    }
    let out = git(ctx, Path::new(repo)).args(["cat-file", "--batch"]).stdin(format!("{object}\n")).run()?;
    let stdout = out.stdout;
    let header_end = stdout.iter().position(|&b| b == b'\n').unwrap_or(stdout.len());
    let header = String::from_utf8_lossy(&stdout[..header_end]);
    if header.ends_with(" missing") || header.ends_with(" ambiguous") {
        return Ok(None);
    }
    let mut fields = header.split(' ');
    let (Some(_), Some(kind), Some(size)) = (fields.next(), fields.next(), fields.next()) else {
        return Err(Error::new(format!("Failed to parse cat-file header {header:?}.")));
    };
    if kind != "blob" {
        return Err(Error::new(format!("Failed to read {object:?}: it is a {kind}, not a file.")));
    }
    let size: usize = size.parse().map_err(|_| Error::new(format!("Failed to parse cat-file header {header:?}.")))?;
    let start = header_end + 1;
    let body = stdout
        .get(start..start + size)
        .ok_or_else(|| Error::new(format!("Failed to read {object:?}: output ended early.")))?;
    Ok(Some(body.to_vec()))
}

pub fn content(bytes: Option<Vec<u8>>) -> FileContent {
    let Some(bytes) = bytes else {
        return FileContent { exists: false, text: None, binary: false };
    };
    let sniff = &bytes[..bytes.len().min(8000)];
    let text = if sniff.contains(&0) { None } else { String::from_utf8(bytes).ok() };
    FileContent { exists: true, binary: text.is_none(), text }
}

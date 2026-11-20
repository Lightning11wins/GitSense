use std::path::PathBuf;
use std::time::{Duration, SystemTime};

/// Where the helper keeps its files.
///
/// `GITSENSE_HOME` puts everything under one dir. Otherwise the XDG cache and
/// data dirs are used.
pub struct Paths {
    pub home: PathBuf,
    /// Helper binaries, named `helper-<sha256>`.
    pub cache: PathBuf,
    /// Repo list, changelists, shelf.
    pub state: PathBuf,
}

const UNUSED_HELPER_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

impl Paths {
    pub fn from_env() -> Result<Self, String> {
        let home =
            std::env::var_os("HOME").map(PathBuf::from).ok_or("Failed to find the home dir: HOME is not set.")?;
        let env_dir = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
        let (cache, state) = match env_dir("GITSENSE_HOME") {
            Some(dir) => (dir.join("cache"), dir.join("state")),
            None => (
                env_dir("XDG_CACHE_HOME").unwrap_or_else(|| home.join(".cache")).join("gitsense"),
                env_dir("XDG_DATA_HOME").unwrap_or_else(|| home.join(".local/share")).join("gitsense"),
            ),
        };
        Ok(Self { home, cache, state })
    }

    /// Marks the running helper as used and deletes helpers unused for 30 days.
    pub fn prune_old_helpers(&self) {
        let Ok(current) = std::env::current_exe() else { return };
        // Read-only: a running executable can't be opened for writing.
        if let Ok(file) = std::fs::File::open(&current) {
            let _ = file.set_modified(SystemTime::now());
        }
        let Ok(entries) = std::fs::read_dir(&self.cache) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_helper = entry.file_name().to_string_lossy().starts_with("helper-");
            let age = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok());
            if is_helper && path != current && age.is_some_and(|age| age > UNUSED_HELPER_AGE) {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

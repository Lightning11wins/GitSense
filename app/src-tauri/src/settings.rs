use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    /// Machine id reopened on launch.
    pub last_machine: Option<String>,
    /// Minutes between background fetches of every repo, or 0 for never.
    pub auto_fetch_minutes: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self { last_machine: None, auto_fetch_minutes: 5 }
    }
}

/// Client settings, saved as JSON in the app's config dir.
pub struct Store {
    file: PathBuf,
    settings: Mutex<Settings>,
}

impl Store {
    pub fn load(file: PathBuf) -> Self {
        let settings = std::fs::read(&file)
            .ok()
            .and_then(|bytes| match serde_json::from_slice(&bytes) {
                Ok(settings) => Some(settings),
                Err(e) => {
                    eprintln!("gitsense: Failed to parse '{}', using defaults: {e}", file.display());
                    None
                }
            })
            .unwrap_or_default();
        Self { file, settings: Mutex::new(settings) }
    }

    pub fn get(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }

    pub fn update(&self, change: impl FnOnce(&mut Settings)) {
        let mut settings = self.settings.lock().unwrap();
        change(&mut settings);
        let json = serde_json::to_vec_pretty(&*settings).expect("Failed to serialize settings");
        let saved =
            self.file.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|()| std::fs::write(&self.file, json));
        if let Err(e) = saved {
            eprintln!("gitsense: Failed to save '{}': {e}", self.file.display());
        }
    }
}

//! A temporary machine for driving the helper through the local transport.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use gitsense_client::{ClientEvent, ConnectOptions, Connection, HelperBinary, Transport, connect};
use gitsense_protocol::Event;
use tokio::sync::mpsc::UnboundedReceiver;

/// A fake home dir with its own git config, and the helper's own dir.
pub struct Machine {
    pub root: tempfile::TempDir,
}

pub struct Session {
    pub conn: Connection,
    pub events: UnboundedReceiver<ClientEvent>,
}

pub fn helper() -> HelperBinary {
    let bytes = std::fs::read(env!("CARGO_BIN_EXE_gitsense-helper")).expect("Failed to read the helper binary");
    HelperBinary::new(bytes)
}

impl Machine {
    pub fn new() -> Self {
        let root = tempfile::tempdir().expect("Failed to create a temp dir");
        let machine = Self { root };
        std::fs::create_dir_all(machine.home()).unwrap();
        std::fs::write(
            machine.home().join(".gitconfig"),
            "[user]\n\tname = Test User\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n",
        )
        .unwrap();
        machine
    }

    pub fn home(&self) -> PathBuf {
        self.root.path().join("home")
    }

    pub fn gitsense_home(&self) -> PathBuf {
        self.root.path().join("gitsense")
    }

    pub fn options(&self) -> ConnectOptions {
        ConnectOptions {
            env: vec![
                ("HOME".into(), self.home().display().to_string()),
                ("GITSENSE_HOME".into(), self.gitsense_home().display().to_string()),
                ("XDG_CONFIG_HOME".into(), self.home().join(".config").display().to_string()),
            ],
        }
    }

    pub async fn connect(&self, transport: &Transport) -> Session {
        let (conn, events) = connect(transport, &helper(), &self.options()).await.expect("Failed to connect");
        Session { conn, events }
    }

    pub async fn connect_local(&self) -> Session {
        self.connect(&Transport::Local).await
    }

    /// Runs git in `dir` with this machine's home and returns stdout.
    pub fn git(&self, dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .current_dir(dir)
            .args(args)
            .env("HOME", self.home())
            .env("XDG_CONFIG_HOME", self.home().join(".config"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .expect("Failed to run git");
        assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap()
    }

    /// Creates a repo at `rel` under home with one commit of `README.md`.
    pub fn repo(&self, rel: &str) -> PathBuf {
        let dir = self.home().join(rel);
        std::fs::create_dir_all(&dir).unwrap();
        self.git(&dir, &["init", "-q"]);
        std::fs::write(dir.join("README.md"), "# Project\n").unwrap();
        self.git(&dir, &["add", "README.md"]);
        self.git(&dir, &["commit", "-q", "-m", "Initial commit."]);
        dir
    }
}

impl Session {
    /// Waits for an event matching `want`, failing after a few seconds.
    pub async fn wait_for(&mut self, mut want: impl FnMut(&Event) -> bool) -> Event {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let event = tokio::time::timeout_at(deadline, self.events.recv())
                .await
                .expect("Timed out waiting for an event")
                .expect("The event channel closed");
            match event {
                ClientEvent::Helper(event) if want(&event) => return event,
                ClientEvent::Helper(_) => {}
                ClientEvent::Disconnected { reason } => panic!("Disconnected: {reason}"),
            }
        }
    }
}

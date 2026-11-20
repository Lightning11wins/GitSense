use std::ffi::OsString;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Instant;

use gitsense_protocol::{Event, GitCommandLog};

use crate::{Ctx, Error, Output as HelperOutput, Result};

const LOG_OUTPUT_LIMIT: usize = 64 * 1024;

pub fn version() -> Result<String> {
    let out = Command::new("git")
        .arg("--version")
        .output()
        .map_err(|e| Error::new(format!("Failed to run 'git --version': {e}")))?;
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text.trim().trim_start_matches("git version ").to_string())
}

/// A git command in a repo. Commands are quiet by default; [`Git::logged`]
/// reports them to the Git Console, for commands that change the repo or
/// talk to a remote.
pub struct Git<'a> {
    out: HelperOutput,
    repo: &'a Path,
    args: Vec<OsString>,
    logged: bool,
    stdin: Option<Vec<u8>>,
    env: Vec<(OsString, OsString)>,
}

pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub code: Option<i32>,
}

impl Output {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }

    pub fn stdout_str(&self) -> Result<&str> {
        std::str::from_utf8(&self.stdout).map_err(|e| Error::new(format!("Failed to read git output as UTF-8: {e}")))
    }
}

pub fn git<'a>(ctx: &Ctx, repo: &'a Path) -> Git<'a> {
    Git::new(ctx.out.clone(), repo)
}

impl<'a> Git<'a> {
    pub fn new(out: HelperOutput, repo: &'a Path) -> Self {
        Git { out, repo, args: Vec::new(), logged: false, stdin: None, env: Vec::new() }
    }

    pub fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn args<I: IntoIterator<Item = S>, S: Into<OsString>>(mut self, args: I) -> Self {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    pub fn logged(mut self) -> Self {
        self.logged = true;
        self
    }

    pub fn stdin(mut self, input: impl Into<Vec<u8>>) -> Self {
        self.stdin = Some(input.into());
        self
    }

    pub fn env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    /// Runs the command and fails unless it exits with 0.
    pub fn run(self) -> Result<Output> {
        let display = self.display();
        let repo = self.repo.display().to_string();
        let out = self.run_unchecked()?;
        if !out.success() {
            let code = out.code.map_or("a signal".to_string(), |c| c.to_string());
            return Err(Error::new(format!(
                "Failed to run '{display}' in '{repo}' (exit {code}): {}",
                out.stderr.trim()
            )));
        }
        Ok(out)
    }

    /// Runs the command and returns its output whatever its exit code.
    pub fn run_unchecked(self) -> Result<Output> {
        let started = Instant::now();
        let mut cmd = Command::new("git");
        cmd.current_dir(self.repo)
            .args(["-c", "core.quotepath=false", "-c", "color.ui=false"])
            .args(&self.args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("LC_ALL", "C")
            .stdin(if self.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if !self.logged {
            // Read-only queries must not take the index lock from the user's own git commands.
            cmd.env("GIT_OPTIONAL_LOCKS", "0");
        }
        for (key, value) in &self.env {
            cmd.env(key, value);
        }
        let mut child = cmd.spawn().map_err(|e| Error::new(format!("Failed to start '{}': {e}", self.display())))?;
        if let Some(input) = &self.stdin {
            let mut stdin = child.stdin.take().expect("stdin is piped");
            let input = input.clone();
            // Write from a thread so a full stdout pipe can't deadlock us.
            std::thread::spawn(move || stdin.write_all(&input));
        }
        let out = child
            .wait_with_output()
            .map_err(|e| Error::new(format!("Failed to wait for '{}': {e}", self.display())))?;
        let output = Output {
            stdout: out.stdout,
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            code: out.status.code(),
        };
        if self.logged {
            let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
            text.push_str(&output.stderr);
            if text.len() > LOG_OUTPUT_LIMIT {
                let mut end = LOG_OUTPUT_LIMIT;
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                text.truncate(end);
                text.push_str("\n[output truncated]");
            }
            self.out.event(Event::GitCommand(GitCommandLog {
                repo: self.repo.display().to_string(),
                args: self.args.iter().map(|a| a.to_string_lossy().into_owned()).collect(),
                exit_code: output.code,
                duration_ms: started.elapsed().as_millis() as u64,
                output: text,
            }));
        }
        Ok(output)
    }

    fn display(&self) -> String {
        let mut s = String::from("git");
        for arg in &self.args {
            s.push(' ');
            s.push_str(&arg.to_string_lossy());
        }
        s
    }
}

//! Installs and starts the helper through a POSIX shell's stdin.
//!
//! The shell only reads script text: the helper upload is a heredoc, so no
//! command competes with the shell for stdin. Nothing is written after the
//! final `exec` until the helper reports ready.

use base64::Engine;
use gitsense_protocol::{Event, HelperMessage};
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};

use crate::{ConnectOptions, Error, HelperBinary, HelperInfo};

const SUPPORTED_ARCH: &str = "x86_64";
const MIN_GIT: (u32, u32) = (2, 34);
const STATUS_MARKER: &str = "gitsense-bootstrap\t";
const ERROR_MARKER: &str = "gitsense-bootstrap-error\t";

type Lines = tokio::io::Lines<BufReader<ChildStdout>>;

pub(crate) async fn start_helper(
    label: &str,
    helper: &HelperBinary,
    options: &ConnectOptions,
    stdin: &mut ChildStdin,
    stdout: &mut Lines,
) -> Result<HelperInfo, Error> {
    if let Some((name, _)) = options.env.iter().find(|(name, _)| !is_env_name(name)) {
        return Err(Error(format!("Failed to set environment variable {name:?}: not a valid name.")));
    }
    let send = |what: &'static str| move |e: std::io::Error| Error(format!("Failed to {what} on {label}: {e}"));
    stdin.write_all(probe_script(helper.hash(), options).as_bytes()).await.map_err(send("start the bootstrap"))?;
    stdin.flush().await.map_err(send("start the bootstrap"))?;

    let status = loop {
        match read_line(label, stdout).await? {
            line if line.starts_with(STATUS_MARKER) => break line,
            // Login scripts sometimes print to stdout; ignore it.
            _ => continue,
        }
    };
    let fields: Vec<&str> = status[STATUS_MARKER.len()..].splitn(3, '\t').collect();
    let [arch, have, git] = fields[..] else {
        return Err(Error(format!("Failed to parse bootstrap status {status:?} from {label}.")));
    };
    if arch != SUPPORTED_ARCH {
        return Err(Error(format!(
            "Failed to connect to {label}: its CPU is {arch}, and only {SUPPORTED_ARCH} is supported."
        )));
    }
    check_git(label, git)?;

    let mut script = String::new();
    if have != "present" {
        script.push_str(&upload_script(helper));
    }
    script.push_str(&format!(
        "if [ -x \"$gs_helper\" ]; then exec \"$gs_helper\"; fi\n\
         printf '{ERROR_MARKER}%s\\n' \"Failed to install the helper at $gs_helper.\"\nexit 1\n"
    ));
    stdin.write_all(script.as_bytes()).await.map_err(send("install the helper"))?;
    stdin.flush().await.map_err(send("install the helper"))?;

    loop {
        let line = read_line(label, stdout).await?;
        if let Some(message) = line.strip_prefix(ERROR_MARKER) {
            return Err(Error(message.to_string()));
        }
        if let Ok(HelperMessage::Event { event: Event::Ready { helper_version, git_version, home } }) =
            serde_json::from_str(&line)
        {
            return Ok(HelperInfo { helper_version, git_version, home });
        }
    }
}

async fn read_line(label: &str, stdout: &mut Lines) -> Result<String, Error> {
    match stdout.next_line().await {
        Ok(Some(line)) => Ok(line),
        Ok(None) => Err(Error(format!("Failed to connect to {label}: the shell exited."))),
        Err(e) => Err(Error(format!("Failed to read from {label}: {e}"))),
    }
}

fn probe_script(hash: &str, options: &ConnectOptions) -> String {
    let mut script = String::new();
    for (name, value) in &options.env {
        script.push_str(&format!("{name}={}; export {name}\n", shell_quote(value)));
    }
    script.push_str(&format!(
        r#"if [ -n "${{GITSENSE_HOME:-}}" ]; then gs_cache="$GITSENSE_HOME/cache"; else gs_cache="${{XDG_CACHE_HOME:-$HOME/.cache}}/gitsense"; fi
gs_helper="$gs_cache/helper-{hash}"
if [ -x "$gs_helper" ]; then gs_have=present; else gs_have=missing; fi
printf '{STATUS_MARKER}%s\t%s\t%s\n' "$(uname -m </dev/null)" "$gs_have" "$(git --version </dev/null 2>&1 | head -n 1)"
"#
    ));
    script
}

fn upload_script(helper: &HelperBinary) -> String {
    use std::io::Write;
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(helper.bytes()).expect("Failed to compress the helper");
    let encoded = base64::engine::general_purpose::STANDARD.encode(gz.finish().expect("Failed to compress the helper"));
    let hash = helper.hash();
    let mut script = String::with_capacity(encoded.len() + encoded.len() / 76 + 512);
    script.push_str(
        "mkdir -p \"$gs_cache\" && gs_tmp=\"$gs_helper.tmp.$$\" && \
         base64 -d <<'GITSENSE_HELPER_EOF' | gzip -dc > \"$gs_tmp\"\n",
    );
    for chunk in encoded.as_bytes().chunks(76) {
        script.push_str(std::str::from_utf8(chunk).expect("base64 is ASCII"));
        script.push('\n');
    }
    script.push_str("GITSENSE_HELPER_EOF\n");
    script.push_str(&format!(
        "if [ \"$(sha256sum \"$gs_tmp\" </dev/null | cut -d ' ' -f 1)\" = {hash} ]; then \
         chmod 755 \"$gs_tmp\" && mv -f \"$gs_tmp\" \"$gs_helper\"; else rm -f \"$gs_tmp\"; fi\n"
    ));
    script
}

fn check_git(label: &str, version_line: &str) -> Result<(), Error> {
    let version = version_line.strip_prefix("git version ").unwrap_or("");
    let mut parts = version.split(['.', ' ']).map(|p| p.parse::<u32>().ok());
    let found = match (parts.next().flatten(), parts.next().flatten()) {
        (Some(major), Some(minor)) => Some((major, minor)),
        _ => None,
    };
    match found {
        Some(found) if found >= MIN_GIT => Ok(()),
        _ => Err(Error(format!(
            "Failed to use git on {label}: found {version_line:?}, need git {}.{} or newer.",
            MIN_GIT.0, MIN_GIT.1
        ))),
    }
}

fn is_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_supported_git_versions() {
        assert!(check_git("host", "git version 2.34.1").is_ok());
        assert!(check_git("host", "git version 2.47.3 (Apple Git-1)").is_ok());
        assert!(check_git("host", "git version 3.0.0").is_ok());
    }

    #[test]
    fn rejects_old_or_missing_git() {
        assert!(check_git("host", "git version 2.25.1").is_err());
        assert!(check_git("host", "sh: 1: git: not found").is_err());
    }
}

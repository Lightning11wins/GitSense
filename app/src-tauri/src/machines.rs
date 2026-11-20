//! Machines to connect to: this computer and hosts from `~/.ssh/config`.

use std::path::{Path, PathBuf};

use serde::Serialize;

pub const LOCAL_ID: &str = "local";

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Machine {
    pub id: String,
    pub label: String,
    /// SSH host, or None for this computer.
    pub host: Option<String>,
}

pub fn list() -> Vec<Machine> {
    let mut machines = vec![Machine { id: LOCAL_ID.into(), label: "This computer".into(), host: None }];
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return machines };
    let ssh_dir = home.join(".ssh");
    let mut hosts = Vec::new();
    read_hosts(&ssh_dir.join("config"), &ssh_dir, &mut hosts, 0);
    for host in hosts {
        if !machines.iter().any(|m| m.host.as_deref() == Some(&host)) {
            machines.push(Machine { id: format!("ssh:{host}"), label: host.clone(), host: Some(host) });
        }
    }
    machines
}

pub fn find(id: &str) -> Option<Machine> {
    if let Some(host) = id.strip_prefix("ssh:") {
        // Hosts may be typed by hand, so they need not be in the config.
        return Some(Machine { id: id.into(), label: host.into(), host: Some(host.into()) });
    }
    list().into_iter().find(|m| m.id == id)
}

/// Collects concrete `Host` names from an ssh config file and its `Include`s.
fn read_hosts(file: &Path, ssh_dir: &Path, hosts: &mut Vec<String>, depth: usize) {
    let Ok(text) = std::fs::read_to_string(file) else { return };
    if depth > 8 {
        return;
    }
    for line in text.lines() {
        let line = line.trim();
        let Some((keyword, rest)) = line.split_once(|c: char| c.is_whitespace() || c == '=') else { continue };
        let values = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '=').split_whitespace();
        if keyword.eq_ignore_ascii_case("host") {
            for name in values {
                if !name.contains(['*', '?', '!']) {
                    hosts.push(name.to_string());
                }
            }
        } else if keyword.eq_ignore_ascii_case("include") {
            for pattern in values {
                for path in expand(pattern, ssh_dir) {
                    read_hosts(&path, ssh_dir, hosts, depth + 1);
                }
            }
        }
    }
}

/// Expands an `Include` path: `~/`, paths relative to `~/.ssh`, and `*` in the file name.
fn expand(pattern: &str, ssh_dir: &Path) -> Vec<PathBuf> {
    let path = match pattern.strip_prefix("~/") {
        Some(rest) => ssh_dir.parent().unwrap_or(ssh_dir).join(rest),
        None => ssh_dir.join(pattern),
    };
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !name.contains('*') {
        return vec![path];
    }
    let dir = path.parent().unwrap_or(ssh_dir);
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| wildcard_match(&name, &e.file_name().to_string_lossy()))
        .map(|e| e.path())
        .collect();
    paths.sort();
    paths
}

fn wildcard_match(pattern: &str, text: &str) -> bool {
    match pattern.split_once('*') {
        None => pattern == text,
        Some((prefix, rest)) => {
            let Some(text) = text.strip_prefix(prefix) else { return false };
            (0..=text.len()).filter(|&i| text.is_char_boundary(i)).any(|i| wildcard_match(rest, &text[i..]))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_hosts_and_includes_but_not_patterns() {
        let dir = std::env::temp_dir().join(format!("gitsense-ssh-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("config.d")).unwrap();
        std::fs::write(
            dir.join("config"),
            "Include config.d/*.conf\nHost build dev-box\n  User me\nHost *.internal !skip\nHost=web\n",
        )
        .unwrap();
        std::fs::write(dir.join("config.d/work.conf"), "Host work\n").unwrap();
        let mut hosts = Vec::new();
        read_hosts(&dir.join("config"), &dir, &mut hosts, 0);
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(hosts, ["work", "build", "dev-box", "web"]);
    }
}

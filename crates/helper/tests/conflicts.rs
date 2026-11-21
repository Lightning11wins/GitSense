mod common;

use std::path::{Path, PathBuf};

use common::Machine;
use gitsense_protocol::{Conflict, ConflictAccept, ConflictAcceptParams, ConflictSide, ConflictsList, RepoParams};

fn s(path: &Path) -> String {
    path.display().to_string()
}

fn commit_all(machine: &Machine, repo: &Path, message: &str) {
    machine.git(repo, &["add", "-A"]);
    machine.git(repo, &["commit", "-q", "-m", message]);
}

fn write(repo: &Path, name: &str, text: &str) {
    std::fs::write(repo.join(name), text).unwrap();
}

/// Merges `topic` into `main` with three conflicts:
/// `both.txt` edited on both sides, `gone.txt` edited on `main` and deleted on `topic`, `added.txt` added on both.
fn conflicted_merge(machine: &Machine) -> PathBuf {
    let repo = machine.repo("app");
    write(&repo, "both.txt", "base\n");
    write(&repo, "gone.txt", "base\n");
    commit_all(machine, &repo, "Add files.");
    machine.git(&repo, &["switch", "-q", "-c", "topic"]);
    write(&repo, "both.txt", "topic\n");
    write(&repo, "added.txt", "topic\n");
    std::fs::remove_file(repo.join("gone.txt")).unwrap();
    commit_all(machine, &repo, "Topic changes.");
    machine.git(&repo, &["switch", "-q", "main"]);
    write(&repo, "both.txt", "main\n");
    write(&repo, "added.txt", "main\n");
    write(&repo, "gone.txt", "main\n");
    commit_all(machine, &repo, "Main changes.");
    let out = std::process::Command::new("git")
        .current_dir(&repo)
        .args(["merge", "topic"])
        .env("HOME", machine.home())
        .output()
        .unwrap();
    assert!(!out.status.success());
    repo
}

fn conflict(path: &str, base: bool, ours: bool, theirs: bool) -> Conflict {
    Conflict { path: path.into(), base, ours, theirs }
}

fn accept(repo: &Path, paths: &[&str], side: ConflictSide) -> ConflictAcceptParams {
    ConflictAcceptParams { repo: s(repo), paths: paths.iter().map(|p| p.to_string()).collect(), side }
}

#[tokio::test]
async fn lists_conflicts_with_the_versions_that_exist() {
    let machine = Machine::new();
    let repo = conflicted_merge(&machine);
    let session = machine.connect_local().await;

    let found = session.conn.call::<ConflictsList>(RepoParams { repo: s(&repo) }).await.unwrap();
    assert_eq!(
        found,
        [
            conflict("added.txt", false, true, true),
            conflict("both.txt", true, true, true),
            conflict("gone.txt", true, true, false),
        ]
    );
}

#[tokio::test]
async fn lists_no_conflicts_in_a_clean_repo() {
    let machine = Machine::new();
    let repo = machine.repo("app");
    let session = machine.connect_local().await;
    assert_eq!(session.conn.call::<ConflictsList>(RepoParams { repo: s(&repo) }).await.unwrap(), []);
}

#[tokio::test]
async fn accepts_either_side_and_deletes_files_that_side_deleted() {
    let machine = Machine::new();
    let repo = conflicted_merge(&machine);
    let session = machine.connect_local().await;

    session.conn.call::<ConflictAccept>(accept(&repo, &["added.txt"], ConflictSide::Ours)).await.unwrap();
    session.conn.call::<ConflictAccept>(accept(&repo, &["both.txt", "gone.txt"], ConflictSide::Theirs)).await.unwrap();

    assert_eq!(std::fs::read_to_string(repo.join("added.txt")).unwrap(), "main\n");
    assert_eq!(std::fs::read_to_string(repo.join("both.txt")).unwrap(), "topic\n");
    assert!(!repo.join("gone.txt").exists());
    assert_eq!(machine.git(&repo, &["ls-files", "-u"]), "");
    assert_eq!(machine.git(&repo, &["ls-files"]).lines().collect::<Vec<_>>(), ["README.md", "added.txt", "both.txt"]);
    assert_eq!(session.conn.call::<ConflictsList>(RepoParams { repo: s(&repo) }).await.unwrap(), []);
}

#[tokio::test]
async fn accepting_ours_deletes_a_file_that_our_side_deleted() {
    let machine = Machine::new();
    let repo = conflicted_merge(&machine);
    machine.git(&repo, &["merge", "--abort"]);
    machine.git(&repo, &["switch", "-q", "topic"]);
    let out = std::process::Command::new("git")
        .current_dir(&repo)
        .args(["merge", "main"])
        .env("HOME", machine.home())
        .output()
        .unwrap();
    assert!(!out.status.success());
    let session = machine.connect_local().await;

    session.conn.call::<ConflictAccept>(accept(&repo, &["gone.txt"], ConflictSide::Ours)).await.unwrap();

    assert!(!repo.join("gone.txt").exists());
    assert!(!machine.git(&repo, &["ls-files", "-u"]).contains("gone.txt"));
}

#[tokio::test]
async fn accept_refuses_bad_paths_without_changing_anything() {
    let machine = Machine::new();
    let repo = conflicted_merge(&machine);
    let session = machine.connect_local().await;

    let err = session
        .conn
        .call::<ConflictAccept>(accept(&repo, &["both.txt", "README.md"], ConflictSide::Theirs))
        .await
        .unwrap_err();
    assert!(
        err.to_string().starts_with("Failed to accept theirs for 'README.md'")
            && err.to_string().contains("not conflicted"),
        "{err}"
    );
    let err =
        session.conn.call::<ConflictAccept>(accept(&repo, &["../outside"], ConflictSide::Ours)).await.unwrap_err();
    assert!(err.to_string().contains("'../outside'"), "{err}");
    let err = session.conn.call::<ConflictAccept>(accept(&repo, &[], ConflictSide::Ours)).await.unwrap_err();
    assert!(err.to_string().starts_with("Failed to accept ours"), "{err}");

    assert_eq!(session.conn.call::<ConflictsList>(RepoParams { repo: s(&repo) }).await.unwrap().len(), 3);
}

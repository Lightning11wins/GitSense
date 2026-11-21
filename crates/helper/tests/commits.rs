mod common;

use std::path::Path;

use common::Machine;
use gitsense_protocol::{CommitReword, RewordParams};

fn s(path: &Path) -> String {
    path.display().to_string()
}

/// Commits a new file with the given message and returns the commit hash.
fn commit_file(machine: &Machine, repo: &Path, name: &str, message: &str) -> String {
    std::fs::write(repo.join(name), format!("{name}\n")).unwrap();
    machine.git(repo, &["add", name]);
    machine.git(repo, &["commit", "-q", "-m", message]);
    machine.git(repo, &["rev-parse", "HEAD"]).trim().to_string()
}

fn reword_params(repo: &Path, rev: &str, message: &str) -> RewordParams {
    RewordParams { repo: s(repo), rev: rev.into(), message: message.into() }
}

fn head(machine: &Machine, repo: &Path) -> String {
    machine.git(repo, &["rev-parse", "HEAD"]).trim().to_string()
}

/// Stages a new file, edits a tracked file, and adds an untracked one.
fn make_dirty(repo: &Path, machine: &Machine) {
    std::fs::write(repo.join("staged.txt"), "staged\n").unwrap();
    machine.git(repo, &["add", "staged.txt"]);
    std::fs::write(repo.join("README.md"), "edited\n").unwrap();
    std::fs::write(repo.join("untracked.txt"), "untracked\n").unwrap();
}

#[tokio::test]
async fn rewords_head_without_committing_staged_changes() {
    let machine = Machine::new();
    let repo = machine.repo("app");
    make_dirty(&repo, &machine);
    let before = machine.git(&repo, &["status", "--porcelain"]);
    let tree = machine.git(&repo, &["rev-parse", "HEAD^{tree}"]);
    let session = machine.connect_local().await;

    let message = "New subject\n\nBody text.\n";
    session.conn.call::<CommitReword>(reword_params(&repo, "HEAD", message)).await.unwrap();

    assert_eq!(machine.git(&repo, &["log", "-1", "--format=%B"]), "New subject\n\nBody text.\n\n");
    assert_eq!(machine.git(&repo, &["rev-parse", "HEAD^{tree}"]), tree);
    assert_eq!(machine.git(&repo, &["status", "--porcelain"]), before);
    assert_eq!(machine.git(&repo, &["rev-list", "--count", "HEAD"]).trim(), "1");
}

#[tokio::test]
async fn rewords_an_older_commit_and_leaves_the_working_tree_alone() {
    let machine = Machine::new();
    let repo = machine.repo("app");
    // Equal subjects must not make the wrong commit the target.
    commit_file(&machine, &repo, "a.txt", "Fix.");
    let target = commit_file(&machine, &repo, "b.txt", "Fix.");
    commit_file(&machine, &repo, "c.txt", "Fix.");
    let author = machine.git(&repo, &["log", "-1", "--format=%an <%ae> %aI", &target]);
    let tree = machine.git(&repo, &["rev-parse", "HEAD^{tree}"]);
    make_dirty(&repo, &machine);
    let before = machine.git(&repo, &["status", "--porcelain"]);
    let session = machine.connect_local().await;

    let message = "Add b.\n\nWith a body.\n# not a comment\n";
    session.conn.call::<CommitReword>(reword_params(&repo, &target, message)).await.unwrap();

    assert_eq!(machine.git(&repo, &["log", "--format=%s", "-4"]), "Fix.\nAdd b.\nFix.\nInitial commit.\n");
    assert_eq!(machine.git(&repo, &["log", "-1", "--format=%B", "HEAD~1"]), format!("{message}\n"));
    assert_eq!(machine.git(&repo, &["log", "-1", "--format=%an <%ae> %aI", "HEAD~1"]), author);
    assert_eq!(machine.git(&repo, &["rev-parse", "HEAD^{tree}"]), tree);
    assert_eq!(machine.git(&repo, &["status", "--porcelain"]), before);
    assert_eq!(std::fs::read_to_string(repo.join("README.md")).unwrap(), "edited\n");
    assert_eq!(machine.git(&repo, &["rev-list", "--count", "HEAD"]).trim(), "4");
}

#[tokio::test]
async fn rewords_the_root_commit() {
    let machine = Machine::new();
    let repo = machine.repo("app");
    commit_file(&machine, &repo, "a.txt", "Add a.");
    let root = machine.git(&repo, &["rev-list", "--max-parents=0", "HEAD"]).trim().to_string();
    let session = machine.connect_local().await;

    session.conn.call::<CommitReword>(reword_params(&repo, &root, "Start the project.")).await.unwrap();

    assert_eq!(machine.git(&repo, &["log", "--format=%s"]), "Add a.\nStart the project.\n");
}

#[tokio::test]
async fn refuses_to_reword_unsuitable_commits() {
    let machine = Machine::new();
    let repo = machine.repo("app");
    let base = head(&machine, &repo);
    machine.git(&repo, &["switch", "-q", "-c", "side"]);
    commit_file(&machine, &repo, "side.txt", "Side.");
    machine.git(&repo, &["switch", "-q", "-c", "unmerged", "main"]);
    let unmerged = commit_file(&machine, &repo, "unmerged.txt", "Unmerged.");
    machine.git(&repo, &["switch", "-q", "main"]);
    let before_merge = commit_file(&machine, &repo, "main.txt", "Main.");
    machine.git(&repo, &["merge", "-q", "--no-ff", "-m", "Merge side.", "side"]);
    let merge = head(&machine, &repo);
    commit_file(&machine, &repo, "after.txt", "After.");
    let tip = head(&machine, &repo);
    let session = machine.connect_local().await;

    let refuse = async |rev: &str, message: &str, want: &str| {
        let err = session.conn.call::<CommitReword>(reword_params(&repo, rev, message)).await.unwrap_err();
        let text = err.to_string();
        assert!(text.starts_with("Failed to ") && text.contains(want), "{text}");
        assert_eq!(head(&machine, &repo), tip);
        assert_eq!(machine.git(&repo, &["status", "--porcelain"]), "");
    };
    refuse(&unmerged, "Reworded.", &format!("commit {unmerged} is not an ancestor of HEAD")).await;
    refuse(&before_merge, "Reworded.", &format!("merge commit {merge} lies between it and HEAD")).await;
    refuse(&merge, "Reworded.", &format!("commit {merge} is a merge commit")).await;
    refuse(&base, "Reworded.", "lies between it and HEAD").await;
    refuse(&base, "  \n", "the new message is empty").await;
    refuse("no-such-rev", "Reworded.", "commit 'no-such-rev'").await;
}

#[tokio::test]
async fn refuses_to_reword_during_an_operation() {
    let machine = Machine::new();
    let repo = machine.repo("app");
    let target = commit_file(&machine, &repo, "a.txt", "Add a.");
    machine.git(&repo, &["switch", "-q", "-c", "side", &target]);
    std::fs::write(repo.join("a.txt"), "side\n").unwrap();
    machine.git(&repo, &["commit", "-q", "-am", "Side."]);
    machine.git(&repo, &["switch", "-q", "main"]);
    std::fs::write(repo.join("a.txt"), "main\n").unwrap();
    machine.git(&repo, &["commit", "-q", "-am", "Main."]);
    std::process::Command::new("git")
        .current_dir(&repo)
        .args(["merge", "side"])
        .env("HOME", machine.home())
        .output()
        .unwrap();
    let session = machine.connect_local().await;

    let err = session.conn.call::<CommitReword>(reword_params(&repo, "HEAD", "Reworded.")).await.unwrap_err();
    assert!(err.to_string().contains("a merge is in progress"), "{err}");
}

#[tokio::test]
async fn failed_reword_restores_the_repo() {
    let machine = Machine::new();
    let repo = machine.repo("app");
    let target = commit_file(&machine, &repo, "a.txt", "Add a.");
    commit_file(&machine, &repo, "b.txt", "Add b.");
    make_dirty(&repo, &machine);
    let hook = repo.join(".git/hooks/pre-rebase");
    std::fs::write(&hook, "#!/bin/sh\necho refused >&2\nexit 1\n").unwrap();
    std::fs::set_permissions(&hook, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let tip = head(&machine, &repo);
    let before = machine.git(&repo, &["status", "--porcelain"]);
    let session = machine.connect_local().await;

    let err = session.conn.call::<CommitReword>(reword_params(&repo, &target, "Reworded.")).await.unwrap_err();

    assert!(err.to_string().starts_with("Failed to reword") && err.to_string().contains("refused"), "{err}");
    assert_eq!(head(&machine, &repo), tip);
    assert_eq!(machine.git(&repo, &["status", "--porcelain"]), before);
}

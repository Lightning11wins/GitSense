mod common;

use std::path::{Path, PathBuf};

use common::Machine;
use gitsense_protocol::{Operation, OperationAbort, OperationContinue, OperationSkip, RepoParams, Status};

fn s(path: &Path) -> String {
    path.display().to_string()
}

fn repo_params(repo: &Path) -> RepoParams {
    RepoParams { repo: s(repo) }
}

fn commit_file(machine: &Machine, repo: &Path, name: &str, text: &str) -> String {
    std::fs::write(repo.join(name), text).unwrap();
    machine.git(repo, &["add", name]);
    machine.git(repo, &["commit", "-q", "-m", &format!("Edit {name}.")]);
    machine.git(repo, &["rev-parse", "HEAD"]).trim().to_string()
}

/// A repo on `main` and a branch `topic` that edit `a.txt` differently, with `main` checked out.
fn diverged(machine: &Machine) -> PathBuf {
    let repo = machine.repo("app");
    commit_file(machine, &repo, "a.txt", "base\n");
    machine.git(&repo, &["switch", "-q", "-c", "topic"]);
    commit_file(machine, &repo, "a.txt", "topic\n");
    machine.git(&repo, &["switch", "-q", "main"]);
    commit_file(machine, &repo, "a.txt", "main\n");
    repo
}

/// Marks `a.txt` resolved with `text`.
fn resolve(machine: &Machine, repo: &Path, text: &str) {
    std::fs::write(repo.join("a.txt"), text).unwrap();
    machine.git(repo, &["add", "a.txt"]);
}

fn git_fails(machine: &Machine, repo: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .current_dir(repo)
        .args(args)
        .env("HOME", machine.home())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(!out.status.success(), "git {args:?} should have failed");
}

async fn operation(session: &common::Session, repo: &Path) -> Option<Operation> {
    session.conn.call::<Status>(repo_params(repo)).await.unwrap().operation
}

#[tokio::test]
async fn operations_fail_when_nothing_is_in_progress() {
    let machine = Machine::new();
    let repo = machine.repo("app");
    let session = machine.connect_local().await;
    let p = repo_params(&repo);

    for err in [
        session.conn.call::<OperationContinue>(p.clone()).await.unwrap_err(),
        session.conn.call::<OperationAbort>(p.clone()).await.unwrap_err(),
        session.conn.call::<OperationSkip>(p).await.unwrap_err(),
    ] {
        let message = err.to_string();
        assert!(message.starts_with("Failed to "), "{message}");
        assert!(message.contains(&s(&repo)) && message.contains("none is in progress"), "{message}");
    }
}

#[tokio::test]
async fn continues_a_merge_with_the_prepared_message() {
    let machine = Machine::new();
    let repo = diverged(&machine);
    git_fails(&machine, &repo, &["merge", "topic"]);
    let session = machine.connect_local().await;
    assert_eq!(operation(&session, &repo).await, Some(Operation::Merge));

    let err = session.conn.call::<OperationContinue>(repo_params(&repo)).await.unwrap_err();
    assert!(err.to_string().contains("1 file(s) have conflicts"), "{err}");
    assert_eq!(operation(&session, &repo).await, Some(Operation::Merge));

    resolve(&machine, &repo, "both\n");
    session.conn.call::<OperationContinue>(repo_params(&repo)).await.unwrap();
    assert_eq!(operation(&session, &repo).await, None);
    assert_eq!(machine.git(&repo, &["log", "-1", "--format=%s"]).trim(), "Merge branch 'topic'");
    assert_eq!(machine.git(&repo, &["rev-list", "--parents", "-1", "HEAD"]).split_whitespace().count(), 3);
}

#[tokio::test]
async fn aborts_a_merge_and_refuses_to_skip_it() {
    let machine = Machine::new();
    let repo = diverged(&machine);
    git_fails(&machine, &repo, &["merge", "topic"]);
    let session = machine.connect_local().await;

    let err = session.conn.call::<OperationSkip>(repo_params(&repo)).await.unwrap_err();
    assert!(err.to_string().contains("Failed to skip the merge") && err.to_string().contains(&s(&repo)), "{err}");
    assert_eq!(operation(&session, &repo).await, Some(Operation::Merge));

    session.conn.call::<OperationAbort>(repo_params(&repo)).await.unwrap();
    assert_eq!(operation(&session, &repo).await, None);
    assert_eq!(std::fs::read_to_string(repo.join("a.txt")).unwrap(), "main\n");
}

#[tokio::test]
async fn continues_skips_and_aborts_a_rebase() {
    let machine = Machine::new();
    let repo = diverged(&machine);
    machine.git(&repo, &["switch", "-q", "topic"]);
    commit_file(&machine, &repo, "b.txt", "after\n");
    let topic = machine.git(&repo, &["rev-parse", "HEAD"]).trim().to_string();
    let session = machine.connect_local().await;

    // Continue: resolve the conflict, and the rebase finishes.
    git_fails(&machine, &repo, &["rebase", "main"]);
    assert_eq!(operation(&session, &repo).await, Some(Operation::Rebase));
    resolve(&machine, &repo, "both\n");
    session.conn.call::<OperationContinue>(repo_params(&repo)).await.unwrap();
    assert_eq!(operation(&session, &repo).await, None);
    assert_eq!(machine.git(&repo, &["log", "--format=%s", "main..HEAD"]), "Edit b.txt.\nEdit a.txt.\n");

    // Skip: the conflicting commit is dropped.
    machine.git(&repo, &["reset", "-q", "--hard", &topic]);
    git_fails(&machine, &repo, &["rebase", "main"]);
    session.conn.call::<OperationSkip>(repo_params(&repo)).await.unwrap();
    assert_eq!(operation(&session, &repo).await, None);
    assert_eq!(machine.git(&repo, &["log", "--format=%s", "main..HEAD"]), "Edit b.txt.\n");

    // Abort: the branch returns to where it was.
    machine.git(&repo, &["reset", "-q", "--hard", &topic]);
    git_fails(&machine, &repo, &["rebase", "main"]);
    session.conn.call::<OperationAbort>(repo_params(&repo)).await.unwrap();
    assert_eq!(operation(&session, &repo).await, None);
    assert_eq!(machine.git(&repo, &["rev-parse", "HEAD"]).trim(), topic);
}

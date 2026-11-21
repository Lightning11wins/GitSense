mod common;

use std::path::{Path, PathBuf};

use common::Machine;
use gitsense_protocol::{ChangeKind, CompareCommits, CompareFiles, CompareParams, FileChange};

fn s(path: &Path) -> String {
    path.display().to_string()
}

fn commit_file(machine: &Machine, repo: &Path, name: &str, text: &str) {
    std::fs::write(repo.join(name), text).unwrap();
    machine.git(repo, &["add", name]);
    machine.git(repo, &["commit", "-q", "-m", &format!("Edit {name}.")]);
}

/// `main` has one commit since the fork. `feature` has three: an edit, a rename, and a delete.
fn forked(machine: &Machine) -> PathBuf {
    let repo = machine.repo("app");
    commit_file(machine, &repo, "old.txt", "some old text\nmore lines\n");
    commit_file(machine, &repo, "doomed.txt", "bye\n");
    machine.git(&repo, &["switch", "-q", "-c", "feature"]);
    commit_file(machine, &repo, "README.md", "# Edited\n");
    machine.git(&repo, &["mv", "old.txt", "new.txt"]);
    machine.git(&repo, &["commit", "-q", "-m", "Rename old."]);
    machine.git(&repo, &["rm", "-q", "doomed.txt"]);
    machine.git(&repo, &["commit", "-q", "-m", "Delete doomed."]);
    machine.git(&repo, &["switch", "-q", "main"]);
    commit_file(machine, &repo, "main-only.txt", "main\n");
    repo
}

fn params(repo: &Path, base: &str, head: &str) -> CompareParams {
    CompareParams { repo: s(repo), base: base.into(), head: head.into() }
}

#[tokio::test]
async fn lists_commits_only_in_head_newest_first() {
    let machine = Machine::new();
    let repo = forked(&machine);
    let session = machine.connect_local().await;

    let found = session.conn.call::<CompareCommits>(params(&repo, "main", "feature")).await.unwrap();
    let subjects: Vec<_> = found.iter().map(|c| c.subject.as_str()).collect();
    assert_eq!(subjects, ["Delete doomed.", "Rename old.", "Edit README.md."]);
    assert_eq!(found[0].hash, machine.git(&repo, &["rev-parse", "feature"]).trim());
    assert_eq!(found[0].parents, [found[1].hash.clone()]);

    let swapped = session.conn.call::<CompareCommits>(params(&repo, "feature", "main")).await.unwrap();
    assert_eq!(swapped.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), ["Edit main-only.txt."]);
    assert!(session.conn.call::<CompareCommits>(params(&repo, "main", "main")).await.unwrap().is_empty());
}

#[tokio::test]
async fn lists_head_changes_since_the_merge_base() {
    let machine = Machine::new();
    let repo = forked(&machine);
    let session = machine.connect_local().await;

    let change = |path: &str, orig: Option<&str>, kind| FileChange {
        path: path.into(),
        orig_path: orig.map(String::from),
        kind,
    };
    let compared = session.conn.call::<CompareFiles>(params(&repo, "main", "feature")).await.unwrap();
    assert_eq!(compared.merge_base, machine.git(&repo, &["merge-base", "main", "feature"]).trim());
    let mut found = compared.files;
    found.sort_by(|a, b| a.path.cmp(&b.path));
    // main-only.txt, added on main after the fork, is not listed.
    assert_eq!(
        found,
        [
            change("README.md", None, ChangeKind::Modified),
            change("doomed.txt", None, ChangeKind::Deleted),
            change("new.txt", Some("old.txt"), ChangeKind::Renamed),
        ]
    );

    let swapped = session.conn.call::<CompareFiles>(params(&repo, "feature", "main")).await.unwrap();
    assert_eq!(swapped.files, [change("main-only.txt", None, ChangeKind::Added)]);
}

#[tokio::test]
async fn compare_refuses_bad_revisions_and_unrelated_histories() {
    let machine = Machine::new();
    let repo = forked(&machine);
    machine.git(&repo, &["switch", "-q", "--orphan", "island"]);
    commit_file(&machine, &repo, "island.txt", "alone\n");
    let session = machine.connect_local().await;

    for bad in ["no-such-rev", "-x"] {
        let err = session.conn.call::<CompareCommits>(params(&repo, "main", bad)).await.unwrap_err();
        assert!(err.to_string().starts_with("Failed to ") && err.to_string().contains(bad), "{err}");
        let err = session.conn.call::<CompareFiles>(params(&repo, bad, "main")).await.unwrap_err();
        assert!(err.to_string().starts_with("Failed to ") && err.to_string().contains(bad), "{err}");
    }
    let err = session.conn.call::<CompareFiles>(params(&repo, "main", "island")).await.unwrap_err();
    assert!(err.to_string().starts_with("Failed to ") && err.to_string().contains("main...island"), "{err}");
    let err = session.conn.call::<CompareCommits>(params(&repo, "", "island")).await.unwrap_err();
    assert!(err.to_string().contains("base revision is empty"), "{err}");
}

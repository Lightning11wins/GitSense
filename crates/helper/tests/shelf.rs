mod common;

use std::path::Path;

use common::Machine;
use gitsense_protocol::{
    ChangeKind, RepoParams, ShelfCreate, ShelfCreateParams, ShelfDelete, ShelfFile, ShelfFileParams, ShelfIdParams,
    ShelfList, ShelfUnshelve, ShelfUnshelveParams,
};

fn s(path: &Path) -> String {
    path.display().to_string()
}

fn repo_params(repo: &Path) -> RepoParams {
    RepoParams { repo: s(repo) }
}

fn create(repo: &Path, paths: &[&str]) -> ShelfCreateParams {
    ShelfCreateParams {
        repo: s(repo),
        message: "Work in progress.".into(),
        paths: paths.iter().map(|p| p.to_string()).collect(),
    }
}

fn unshelve(repo: &Path, id: &str, paths: Option<&[&str]>, keep: bool) -> ShelfUnshelveParams {
    ShelfUnshelveParams {
        repo: s(repo),
        id: id.into(),
        paths: paths.map(|p| p.iter().map(|p| p.to_string()).collect()),
        keep,
    }
}

fn id_params(repo: &Path, id: &str) -> ShelfIdParams {
    ShelfIdParams { repo: s(repo), id: id.into() }
}

/// A repo with `a.txt` and `b.txt` committed.
fn two_files(machine: &Machine) -> std::path::PathBuf {
    let app = machine.repo("app");
    std::fs::write(app.join("a.txt"), "a1\na2\na3\n").unwrap();
    std::fs::write(app.join("b.txt"), "b1\n").unwrap();
    machine.git(&app, &["add", "a.txt", "b.txt"]);
    machine.git(&app, &["commit", "-q", "-m", "Add files."]);
    app
}

#[tokio::test]
async fn shelves_changes_and_unshelves_them() {
    let machine = Machine::new();
    let app = two_files(&machine);
    std::fs::write(app.join("a.txt"), "a1\nchanged\na3\n").unwrap();
    std::fs::write(app.join("b.txt"), "b changed\n").unwrap();
    std::fs::write(app.join("README.md"), "# Edited\n").unwrap();
    machine.git(&app, &["add", "README.md"]);

    let session = machine.connect_local().await;
    let entry = session.conn.call::<ShelfCreate>(create(&app, &["a.txt", "b.txt"])).await.unwrap();

    assert_eq!(entry.message, "Work in progress.");
    assert_eq!(entry.base, machine.git(&app, &["rev-parse", "HEAD"]).trim());
    let files: Vec<_> = entry.files.iter().map(|f| (f.path.as_str(), f.kind)).collect();
    assert_eq!(files, [("a.txt", ChangeKind::Modified), ("b.txt", ChangeKind::Modified)]);
    // Shelved paths are reverted; other changes stay, staged or not.
    assert_eq!(std::fs::read_to_string(app.join("a.txt")).unwrap(), "a1\na2\na3\n");
    assert_eq!(machine.git(&app, &["status", "--porcelain"]), "M  README.md\n");
    let listed = session.conn.call::<ShelfList>(repo_params(&app)).await.unwrap();
    assert_eq!(listed, std::slice::from_ref(&entry));

    let sides = session
        .conn
        .call::<ShelfFile>(ShelfFileParams { repo: s(&app), id: entry.id.clone(), path: "a.txt".into() })
        .await
        .unwrap();
    assert_eq!(sides.before.text.as_deref(), Some("a1\na2\na3\n"));
    assert_eq!(sides.after.text.as_deref(), Some("a1\nchanged\na3\n"));
    assert_eq!(std::fs::read_to_string(app.join("a.txt")).unwrap(), "a1\na2\na3\n");

    // Unshelving onto a tree that moved on merges three-way.
    std::fs::write(app.join("a.txt"), "top\na1\na2\na3\n").unwrap();
    session.conn.call::<ShelfUnshelve>(unshelve(&app, &entry.id, None, false)).await.unwrap();
    assert_eq!(std::fs::read_to_string(app.join("a.txt")).unwrap(), "top\na1\nchanged\na3\n");
    assert_eq!(std::fs::read_to_string(app.join("b.txt")).unwrap(), "b changed\n");
    assert_eq!(session.conn.call::<ShelfList>(repo_params(&app)).await.unwrap(), []);
}

#[tokio::test]
async fn unshelves_some_files_and_can_keep_the_entry() {
    let machine = Machine::new();
    let app = two_files(&machine);
    std::fs::write(app.join("a.txt"), "a changed\n").unwrap();
    std::fs::write(app.join("b.txt"), "b changed\n").unwrap();

    let session = machine.connect_local().await;
    let entry = session.conn.call::<ShelfCreate>(create(&app, &["a.txt", "b.txt"])).await.unwrap();

    session.conn.call::<ShelfUnshelve>(unshelve(&app, &entry.id, Some(&["a.txt"]), true)).await.unwrap();
    assert_eq!(machine.git(&app, &["status", "--porcelain"]), " M a.txt\n");
    let listed = session.conn.call::<ShelfList>(repo_params(&app)).await.unwrap();
    assert_eq!(listed[0].files.len(), 2);

    machine.git(&app, &["checkout", "--", "a.txt"]);
    session.conn.call::<ShelfUnshelve>(unshelve(&app, &entry.id, Some(&["a.txt"]), false)).await.unwrap();
    let listed = session.conn.call::<ShelfList>(repo_params(&app)).await.unwrap();
    let left: Vec<_> = listed[0].files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(left, ["b.txt"]);

    // The last file takes the entry with it.
    session.conn.call::<ShelfUnshelve>(unshelve(&app, &entry.id, Some(&["b.txt"]), false)).await.unwrap();
    assert_eq!(session.conn.call::<ShelfList>(repo_params(&app)).await.unwrap(), []);
    assert_eq!(machine.git(&app, &["status", "--porcelain"]), " M a.txt\n M b.txt\n");
}

#[tokio::test]
async fn shelves_added_deleted_and_renamed_files() {
    let machine = Machine::new();
    let app = two_files(&machine);
    std::fs::write(app.join("new.txt"), "new\n").unwrap();
    machine.git(&app, &["add", "new.txt"]);
    machine.git(&app, &["mv", "a.txt", "moved.txt"]);
    std::fs::remove_file(app.join("b.txt")).unwrap();

    let session = machine.connect_local().await;
    let entry =
        session.conn.call::<ShelfCreate>(create(&app, &["new.txt", "a.txt", "moved.txt", "b.txt"])).await.unwrap();

    let files: Vec<_> = entry.files.iter().map(|f| (f.path.as_str(), f.orig_path.as_deref(), f.kind)).collect();
    assert_eq!(
        files,
        [
            ("b.txt", None, ChangeKind::Deleted),
            ("moved.txt", Some("a.txt"), ChangeKind::Renamed),
            ("new.txt", None, ChangeKind::Added),
        ]
    );
    assert_eq!(machine.git(&app, &["status", "--porcelain"]), "");
    assert!(!app.join("new.txt").exists());

    session.conn.call::<ShelfUnshelve>(unshelve(&app, &entry.id, None, false)).await.unwrap();
    assert!(app.join("moved.txt").exists());
    assert!(!app.join("a.txt").exists());
    assert!(!app.join("b.txt").exists());
    assert_eq!(std::fs::read_to_string(app.join("new.txt")).unwrap(), "new\n");
    // Added, deleted, and renamed files are mirrored in the index.
    assert_eq!(machine.git(&app, &["status", "--porcelain"]), "D  b.txt\nR  a.txt -> moved.txt\nA  new.txt\n");
}

#[tokio::test]
async fn conflicting_unshelve_leaves_markers_and_keeps_the_entry() {
    let machine = Machine::new();
    let app = two_files(&machine);
    std::fs::write(app.join("a.txt"), "a1\nshelved\na3\n").unwrap();

    let session = machine.connect_local().await;
    let entry = session.conn.call::<ShelfCreate>(create(&app, &["a.txt"])).await.unwrap();
    std::fs::write(app.join("a.txt"), "a1\nlocal\na3\n").unwrap();

    let err = session.conn.call::<ShelfUnshelve>(unshelve(&app, &entry.id, None, false)).await.unwrap_err();
    assert!(err.to_string().contains("conflicts in a.txt"), "{err}");
    let text = std::fs::read_to_string(app.join("a.txt")).unwrap();
    assert!(text.contains("<<<<<<<") && text.contains("shelved") && text.contains("local"), "{text}");
    assert_eq!(machine.git(&app, &["ls-files", "-u"]).lines().count(), 3);
    assert_eq!(session.conn.call::<ShelfList>(repo_params(&app)).await.unwrap().len(), 1);
}

#[tokio::test]
async fn rejects_bad_shelve_and_lookup_requests() {
    let machine = Machine::new();
    let app = two_files(&machine);
    let other = machine.repo("other");
    std::fs::write(app.join("untracked.txt"), "x\n").unwrap();

    let session = machine.connect_local().await;
    let reject = |err: gitsense_client::Error, want: &str| {
        assert!(err.to_string().contains(want), "wanted {want:?} in {err}");
    };
    reject(session.conn.call::<ShelfCreate>(create(&app, &[])).await.unwrap_err(), "no files");
    reject(session.conn.call::<ShelfCreate>(create(&app, &["untracked.txt"])).await.unwrap_err(), "untracked.txt");
    reject(session.conn.call::<ShelfCreate>(create(&app, &["a.txt"])).await.unwrap_err(), "no changes");
    reject(session.conn.call::<ShelfCreate>(create(&app, &["../x"])).await.unwrap_err(), "../x");

    std::fs::write(app.join("a.txt"), "changed\n").unwrap();
    let entry = session.conn.call::<ShelfCreate>(create(&app, &["a.txt"])).await.unwrap();
    reject(
        session.conn.call::<ShelfUnshelve>(unshelve(&app, &entry.id, Some(&["b.txt"]), false)).await.unwrap_err(),
        "b.txt",
    );
    reject(
        session.conn.call::<ShelfUnshelve>(unshelve(&app, &entry.id, Some(&[]), false)).await.unwrap_err(),
        "no files",
    );
    // Entries belong to their repo, and ids can't climb out of the shelf dir.
    reject(session.conn.call::<ShelfDelete>(id_params(&other, &entry.id)).await.unwrap_err(), "Failed to find");
    reject(session.conn.call::<ShelfDelete>(id_params(&app, "../x")).await.unwrap_err(), "shelf id");
    assert_eq!(session.conn.call::<ShelfList>(repo_params(&other)).await.unwrap(), []);

    session.conn.call::<ShelfDelete>(id_params(&app, &entry.id)).await.unwrap();
    assert_eq!(session.conn.call::<ShelfList>(repo_params(&app)).await.unwrap(), []);
    // Deleting discards the changes.
    assert_eq!(std::fs::read_to_string(app.join("a.txt")).unwrap(), "a1\na2\na3\n");
}

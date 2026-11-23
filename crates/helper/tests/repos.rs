mod common;

use common::Machine;
use gitsense_client::ClientEvent;
use gitsense_protocol::{
    ChangeKind, Empty, Event, FileContent, FileRead, FileReadParams, FileVersion, FileWrite, FileWriteParams,
    PathParams, RepoParams, ReposAdd, ReposList, ReposScan, ReposSetHidden, SetHiddenParams, Status,
};

#[tokio::test]
async fn finds_repos_and_worktrees_but_skips_heavy_dirs() {
    let machine = Machine::new();
    let app = machine.repo("code/app");
    machine.repo("code/app/vendor/lib");
    machine.repo("code/web/node_modules/dep");
    machine.git(&app, &["worktree", "add", "-q", "-b", "feature", "../app-feature"]);

    let session = machine.connect_local().await;
    let repos = session.conn.call::<ReposList>(Empty {}).await.unwrap();
    let home = machine.home().display().to_string();
    let found: Vec<(String, bool)> =
        repos.iter().map(|r| (r.path.strip_prefix(&home).unwrap().to_string(), r.is_worktree)).collect();
    assert_eq!(
        found,
        [
            ("/code/app".to_string(), false),
            ("/code/app-feature".to_string(), true),
            ("/code/app/vendor/lib".to_string(), false),
        ]
    );
    assert_eq!(repos[0].common_dir, repos[1].common_dir);
}

#[tokio::test]
async fn finds_repos_behind_symlinks_once() {
    let machine = Machine::new();
    let home = machine.home();
    machine.repo("code/app");
    let outside = tempfile::tempdir().unwrap();
    let elsewhere = outside.path().join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    machine.git(&elsewhere, &["init", "-q"]);
    std::os::unix::fs::symlink(&elsewhere, home.join("elsewhere-link")).unwrap();
    std::os::unix::fs::symlink(home.join("code"), home.join("code-link")).unwrap();
    std::os::unix::fs::symlink(&home, home.join("code/home-loop")).unwrap();

    let session = machine.connect_local().await;
    let repos = session.conn.call::<ReposList>(Empty {}).await.unwrap();
    let home = home.display().to_string();
    let found: Vec<&str> = repos.iter().map(|r| r.path.strip_prefix(&home).unwrap()).collect();
    assert_eq!(found, ["/code/app", "/elsewhere-link"]);
}

#[tokio::test]
async fn adds_repos_by_home_relative_path() {
    let machine = Machine::new();
    let outside = tempfile::tempdir().unwrap();
    let extra = outside.path().join("extra");
    std::fs::create_dir(&extra).unwrap();
    machine.git(&extra, &["init", "-q"]);
    std::os::unix::fs::symlink(&extra, machine.home().join("extra-link")).unwrap();

    let session = machine.connect_local().await;
    let added = session.conn.call::<ReposAdd>(PathParams { path: "~/extra-link/".into() }).await.unwrap();
    assert_eq!(added.path, machine.home().join("extra-link").display().to_string());
    let again = session.conn.call::<ReposAdd>(PathParams { path: extra.display().to_string() }).await.unwrap();
    assert_eq!(again.path, added.path);
    let relative = session.conn.call::<ReposAdd>(PathParams { path: "extra-link".into() }).await;
    assert!(relative.is_err());
}

#[tokio::test]
async fn keeps_hidden_and_manual_repos_across_scans() {
    let machine = Machine::new();
    let app = machine.repo("app");
    let outside = tempfile::tempdir().unwrap();
    let extra = outside.path().join("extra");
    std::fs::create_dir(&extra).unwrap();
    machine.git(&extra, &["init", "-q"]);
    std::fs::create_dir(extra.join("src")).unwrap();

    let session = machine.connect_local().await;
    session.conn.call::<ReposList>(Empty {}).await.unwrap();
    let added =
        session.conn.call::<ReposAdd>(PathParams { path: extra.join("src").display().to_string() }).await.unwrap();
    assert_eq!(added.path, extra.canonicalize().unwrap().display().to_string());
    let app_path = app.display().to_string();
    session.conn.call::<ReposSetHidden>(SetHiddenParams { repo: app_path.clone(), hidden: true }).await.unwrap();

    let repos = session.conn.call::<ReposScan>(Empty {}).await.unwrap();
    let summary: Vec<(String, bool)> = repos.iter().map(|r| (r.path.clone(), r.hidden)).collect();
    assert!(summary.contains(&(app_path, true)), "{summary:?}");
    assert!(summary.contains(&(added.path.clone(), false)), "{summary:?}");
}

#[tokio::test]
async fn reports_working_tree_changes_against_head() {
    let machine = Machine::new();
    let app = machine.repo("app");
    std::fs::write(app.join("README.md"), "# Project\n\nMore.\n").unwrap();
    std::fs::write(app.join("notes.txt"), "todo\n").unwrap();
    std::fs::write(app.join("staged.txt"), "new\n").unwrap();
    machine.git(&app, &["add", "staged.txt"]);

    let session = machine.connect_local().await;
    let status = session.conn.call::<Status>(RepoParams { repo: app.display().to_string() }).await.unwrap();
    assert_eq!(status.branch.as_deref(), Some("main"));
    let changes: Vec<(&str, ChangeKind)> = status.changes.iter().map(|c| (c.path.as_str(), c.kind)).collect();
    assert_eq!(
        changes,
        [("README.md", ChangeKind::Modified), ("notes.txt", ChangeKind::Untracked), ("staged.txt", ChangeKind::Added)]
    );
}

#[tokio::test]
async fn reads_file_versions_and_writes_the_working_tree() {
    let machine = Machine::new();
    let app = machine.repo("app");
    std::fs::write(app.join("README.md"), "# Changed\n").unwrap();
    let repo = app.display().to_string();
    let session = machine.connect_local().await;
    let read = |version| {
        session.conn.call::<FileRead>(FileReadParams { repo: repo.clone(), path: "README.md".into(), version })
    };

    let head = read(FileVersion::Revision { rev: "HEAD".into() }).await.unwrap();
    assert_eq!(head, FileContent { exists: true, text: Some("# Project\n".into()), binary: false });
    let working = read(FileVersion::WorkingTree).await.unwrap();
    assert_eq!(working.text.as_deref(), Some("# Changed\n"));
    let missing = session
        .conn
        .call::<FileRead>(FileReadParams {
            repo: repo.clone(),
            path: "nope.txt".into(),
            version: FileVersion::Revision { rev: "HEAD".into() },
        })
        .await
        .unwrap();
    assert!(!missing.exists);

    session
        .conn
        .call::<FileWrite>(FileWriteParams { repo: repo.clone(), path: "README.md".into(), text: "# Edited\n".into() })
        .await
        .unwrap();
    assert_eq!(std::fs::read_to_string(app.join("README.md")).unwrap(), "# Edited\n");

    let escape = session
        .conn
        .call::<FileWrite>(FileWriteParams { repo, path: "../outside.txt".into(), text: String::new() })
        .await;
    assert!(escape.is_err());
}

#[tokio::test]
async fn reports_changes_to_watched_repos() {
    let machine = Machine::new();
    let app = machine.repo("app");
    std::fs::create_dir(app.join("src")).unwrap();
    let mut session = machine.connect_local().await;
    session.conn.call::<ReposList>(Empty {}).await.unwrap();
    // Let the watcher finish adding watches.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    std::fs::write(app.join("src/main.rs"), "fn main() {}\n").unwrap();
    let repo = app.display().to_string();
    session.wait_for(|e| matches!(e, Event::RepoChanged { repo: r } if *r == repo)).await;

    // Dirs created after watching started are watched too.
    std::fs::create_dir(app.join("src/new")).unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    while session.events.try_recv().is_ok() {}
    std::fs::write(app.join("src/new/file.rs"), "\n").unwrap();
    session.wait_for(|e| matches!(e, Event::RepoChanged { repo: r } if *r == repo)).await;
}

#[tokio::test]
async fn reading_status_is_not_reported_as_a_change() {
    let machine = Machine::new();
    let app = machine.repo("app");
    let mut session = machine.connect_local().await;
    session.conn.call::<ReposList>(Empty {}).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    while session.events.try_recv().is_ok() {}

    let repo = app.display().to_string();
    session.conn.call::<Status>(RepoParams { repo: repo.clone() }).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    while let Ok(event) = session.events.try_recv() {
        assert!(!matches!(event, ClientEvent::Helper(Event::RepoChanged { .. })), "{event:?}");
    }
}

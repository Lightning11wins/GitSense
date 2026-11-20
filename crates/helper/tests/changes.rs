mod common;

use std::path::Path;

use common::{Machine, Session};
use gitsense_protocol::{
    ChangeKind, Commit, CommitMessage, CommitParams, Event, FilesAdd, FilesDelete, IgnoreAdd, IgnoreAddParams,
    IgnoreFile, IgnoreTargets, PathsParams, RepoParams, RevParams, Rollback, RollbackParams, Status,
};

async fn changes(session: &Session, repo: &Path) -> Vec<(String, ChangeKind)> {
    let status = session.conn.call::<Status>(RepoParams { repo: repo.display().to_string() }).await.unwrap();
    status.changes.into_iter().map(|c| (c.path, c.kind)).collect()
}

fn changed(list: &[(&str, ChangeKind)]) -> Vec<(String, ChangeKind)> {
    list.iter().map(|(p, k)| (p.to_string(), *k)).collect()
}

fn commit_params(repo: &Path, paths: &[&str], message: &str) -> CommitParams {
    CommitParams {
        repo: repo.display().to_string(),
        paths: paths.iter().map(|p| p.to_string()).collect(),
        message: message.into(),
        amend: false,
    }
}

fn paths_params(repo: &Path, paths: &[&str]) -> PathsParams {
    PathsParams { repo: repo.display().to_string(), paths: paths.iter().map(|p| p.to_string()).collect() }
}

#[tokio::test]
async fn commits_only_the_selected_files() {
    let machine = Machine::new();
    let app = machine.repo("app");
    std::fs::write(app.join("README.md"), "# Project\n\nMore.\n").unwrap();
    std::fs::write(app.join("notes.txt"), "new file\n").unwrap();
    std::fs::write(app.join("staged.txt"), "staged\n").unwrap();
    std::fs::write(app.join("other.txt"), "untouched\n").unwrap();
    machine.git(&app, &["add", "staged.txt"]);

    let mut session = machine.connect_local().await;
    let message = "Describe the project.\n\nAdds notes.";
    let result = session.conn.call::<Commit>(commit_params(&app, &["README.md", "notes.txt"], message)).await.unwrap();

    assert_eq!(machine.git(&app, &["rev-parse", "HEAD"]).trim(), result.hash);
    assert_eq!(machine.git(&app, &["log", "-1", "--format=%B"]).trim_end(), message);
    assert_eq!(machine.git(&app, &["show", "--name-only", "--format="]), "README.md\nnotes.txt\n");
    assert_eq!(
        changes(&session, &app).await,
        changed(&[("other.txt", ChangeKind::Untracked), ("staged.txt", ChangeKind::Added)])
    );
    session.wait_for(|e| matches!(e, Event::GitCommand(c) if c.args.first().is_some_and(|a| a == "commit"))).await;
}

#[tokio::test]
async fn commits_deletions_and_renames() {
    let machine = Machine::new();
    let app = machine.repo("app");
    std::fs::write(app.join("old.txt"), "content\n").unwrap();
    machine.git(&app, &["add", "old.txt"]);
    machine.git(&app, &["commit", "-q", "-m", "Add old."]);
    machine.git(&app, &["mv", "old.txt", "new.txt"]);
    std::fs::remove_file(app.join("README.md")).unwrap();

    let session = machine.connect_local().await;
    session.conn.call::<Commit>(commit_params(&app, &["README.md", "new.txt", "old.txt"], "Move.")).await.unwrap();

    assert_eq!(machine.git(&app, &["ls-tree", "--name-only", "HEAD"]), "new.txt\n");
    assert_eq!(changes(&session, &app).await, []);
}

#[tokio::test]
async fn makes_the_first_commit_of_a_new_repo() {
    let machine = Machine::new();
    let app = machine.home().join("app");
    std::fs::create_dir_all(&app).unwrap();
    machine.git(&app, &["init", "-q"]);
    std::fs::write(app.join("main.rs"), "fn main() {}\n").unwrap();

    let session = machine.connect_local().await;
    session.conn.call::<Commit>(commit_params(&app, &["main.rs"], "Start.")).await.unwrap();

    assert_eq!(machine.git(&app, &["log", "--format=%s"]), "Start.\n");
}

#[tokio::test]
async fn amends_head_with_more_files_or_only_a_new_message() {
    let machine = Machine::new();
    let app = machine.repo("app");
    std::fs::write(app.join("README.md"), "# Project v2\n").unwrap();
    let repo = app.display().to_string();

    let session = machine.connect_local().await;
    let amend = CommitParams { amend: true, ..commit_params(&app, &["README.md"], "Initial commit, v2.") };
    session.conn.call::<Commit>(amend).await.unwrap();
    std::fs::write(app.join("README.md"), "# Project v3\n").unwrap();
    let reword = CommitParams { amend: true, ..commit_params(&app, &[], "Initial commit, reworded.") };
    session.conn.call::<Commit>(reword).await.unwrap();

    assert_eq!(machine.git(&app, &["rev-list", "--count", "HEAD"]), "1\n");
    assert_eq!(machine.git(&app, &["show", "HEAD:README.md"]), "# Project v2\n");
    let message = session.conn.call::<CommitMessage>(RevParams { repo, rev: "HEAD".into() }).await.unwrap();
    assert_eq!(message, "Initial commit, reworded.");
    assert_eq!(changes(&session, &app).await, changed(&[("README.md", ChangeKind::Modified)]));
}

#[tokio::test]
async fn refuses_paths_outside_the_repo() {
    let machine = Machine::new();
    let app = machine.repo("app");
    let session = machine.connect_local().await;
    let error = session.conn.call::<Commit>(commit_params(&app, &["../escape"], "Escape.")).await.unwrap_err();
    assert!(error.to_string().contains("../escape"), "{error}");
}

#[tokio::test]
async fn rolls_back_to_head_keeping_or_deleting_added_files() {
    let machine = Machine::new();
    let app = machine.repo("app");
    std::fs::write(app.join("README.md"), "changed\n").unwrap();
    std::fs::write(app.join("kept.txt"), "added\n").unwrap();
    std::fs::write(app.join("deleted.txt"), "added\n").unwrap();
    machine.git(&app, &["add", "README.md", "kept.txt", "deleted.txt"]);
    let repo = app.display().to_string();

    let session = machine.connect_local().await;
    let params = |paths: &[&str], delete_added| RollbackParams {
        repo: repo.clone(),
        paths: paths.iter().map(|p| p.to_string()).collect(),
        delete_added,
    };
    session.conn.call::<Rollback>(params(&["README.md", "kept.txt"], false)).await.unwrap();
    session.conn.call::<Rollback>(params(&["deleted.txt"], true)).await.unwrap();

    assert_eq!(std::fs::read_to_string(app.join("README.md")).unwrap(), "# Project\n");
    assert!(!app.join("deleted.txt").exists());
    assert_eq!(changes(&session, &app).await, changed(&[("kept.txt", ChangeKind::Untracked)]));
}

#[tokio::test]
async fn adds_and_deletes_files_by_literal_path() {
    let machine = Machine::new();
    let app = machine.repo("app");
    for name in ["*.txt", "a.txt", "b.txt"] {
        std::fs::write(app.join(name), "text\n").unwrap();
    }

    let session = machine.connect_local().await;
    session.conn.call::<FilesAdd>(paths_params(&app, &["*.txt"])).await.unwrap();
    session.conn.call::<FilesDelete>(paths_params(&app, &["b.txt"])).await.unwrap();

    assert_eq!(
        changes(&session, &app).await,
        changed(&[("*.txt", ChangeKind::Added), ("a.txt", ChangeKind::Untracked)])
    );
}

#[tokio::test]
async fn ignores_files_in_a_chosen_ignore_file() {
    let machine = Machine::new();
    let app = machine.repo("app");
    std::fs::create_dir_all(app.join("web/src")).unwrap();
    std::fs::write(app.join("web/.gitignore"), "dist").unwrap();
    for name in ["web/src/a [draft].log", "web/src/b.log", "web/notes.md"] {
        std::fs::write(app.join(name), "text\n").unwrap();
    }

    let session = machine.connect_local().await;
    let targets = session.conn.call::<IgnoreTargets>(paths_params(&app, &["web/src/a [draft].log", "web/src/b.log"]));
    assert_eq!(
        targets.await.unwrap(),
        [IgnoreFile::Gitignore { dir: "".into() }, IgnoreFile::Gitignore { dir: "web".into() }, IgnoreFile::Exclude]
    );
    let add = |file, paths: &[&str]| IgnoreAddParams {
        repo: app.display().to_string(),
        file,
        paths: paths.iter().map(|p| p.to_string()).collect(),
    };
    let web = IgnoreFile::Gitignore { dir: "web".into() };
    session.conn.call::<IgnoreAdd>(add(web, &["web/src/a [draft].log"])).await.unwrap();
    session.conn.call::<IgnoreAdd>(add(IgnoreFile::Exclude, &["web/notes.md"])).await.unwrap();

    assert_eq!(std::fs::read_to_string(app.join("web/.gitignore")).unwrap(), "dist\n/src/a \\[draft].log\n");
    assert_eq!(
        changes(&session, &app).await,
        changed(&[("web/.gitignore", ChangeKind::Untracked), ("web/src/b.log", ChangeKind::Untracked)])
    );
}

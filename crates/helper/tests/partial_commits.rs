mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use common::Machine;
use gitsense_protocol::{ChangeKind, Commit, CommitContent, CommitParams, RepoParams, Status};

fn params(repo: &Path, paths: &[&str], contents: &[(&str, Option<&str>)], message: &str) -> CommitParams {
    CommitParams {
        repo: repo.display().to_string(),
        paths: paths.iter().map(|p| p.to_string()).collect(),
        message: message.into(),
        amend: false,
        contents: Some(
            contents
                .iter()
                .map(|(path, text)| CommitContent { path: path.to_string(), text: text.map(String::from) })
                .collect(),
        ),
    }
}

async fn changes(session: &common::Session, repo: &Path) -> Vec<(String, ChangeKind)> {
    let status = session.conn.call::<Status>(RepoParams { repo: repo.display().to_string() }).await.unwrap();
    status.changes.into_iter().map(|c| (c.path, c.kind)).collect()
}

fn changed(list: &[(&str, ChangeKind)]) -> Vec<(String, ChangeKind)> {
    list.iter().map(|(p, k)| (p.to_string(), *k)).collect()
}

fn read(repo: &Path, path: &str) -> String {
    std::fs::read_to_string(repo.join(path)).unwrap()
}

#[tokio::test]
async fn commits_the_given_content_and_leaves_the_rest_unstaged() {
    let machine = Machine::new();
    let app = machine.repo("app");
    let edited = "# Project\n\nKeep.\nDraft.\n";
    std::fs::write(app.join("README.md"), edited).unwrap();

    let session = machine.connect_local().await;
    let commit = params(&app, &[], &[("README.md", Some("# Project\n\nKeep.\n"))], "Keep it.");
    let result = session.conn.call::<Commit>(commit).await.unwrap();

    assert_eq!(machine.git(&app, &["rev-parse", "HEAD"]).trim(), result.hash);
    assert_eq!(machine.git(&app, &["show", "HEAD:README.md"]), "# Project\n\nKeep.\n");
    assert_eq!(read(&app, "README.md"), edited);
    assert_eq!(machine.git(&app, &["diff", "--cached", "--name-only"]), "");
    assert_eq!(machine.git(&app, &["diff", "--unified=0", "--format=", "--no-color"]).lines().last(), Some("+Draft."));
    assert_eq!(changes(&session, &app).await, changed(&[("README.md", ChangeKind::Modified)]));
}

#[tokio::test]
async fn mixes_whole_files_and_partial_files() {
    let machine = Machine::new();
    let app = machine.repo("app");
    std::fs::write(app.join("README.md"), "# Project\n\nOne.\nTwo.\n").unwrap();
    std::fs::write(app.join("whole.txt"), "whole\n").unwrap();
    std::fs::write(app.join("staged.txt"), "staged\n").unwrap();
    std::fs::write(app.join("other.txt"), "other\n").unwrap();
    machine.git(&app, &["add", "staged.txt"]);

    let session = machine.connect_local().await;
    let commit = params(&app, &["whole.txt"], &[("README.md", Some("# Project\n\nOne.\n"))], "Mix.");
    session.conn.call::<Commit>(commit).await.unwrap();

    assert_eq!(machine.git(&app, &["show", "--name-only", "--format="]), "README.md\nwhole.txt\n");
    assert_eq!(machine.git(&app, &["show", "HEAD:whole.txt"]), "whole\n");
    assert_eq!(
        changes(&session, &app).await,
        changed(&[
            ("README.md", ChangeKind::Modified),
            ("other.txt", ChangeKind::Untracked),
            ("staged.txt", ChangeKind::Added)
        ])
    );
    assert_eq!(machine.git(&app, &["diff", "--cached", "--name-only"]), "staged.txt\n");
}

#[tokio::test]
async fn commits_a_new_file_with_part_of_its_content() {
    let machine = Machine::new();
    let app = machine.repo("app");
    std::fs::write(app.join("notes.txt"), "first\nsecond\n").unwrap();

    let session = machine.connect_local().await;
    session.conn.call::<Commit>(params(&app, &[], &[("notes.txt", Some("first\n"))], "Notes.")).await.unwrap();

    assert_eq!(machine.git(&app, &["show", "HEAD:notes.txt"]), "first\n");
    assert_eq!(read(&app, "notes.txt"), "first\nsecond\n");
    assert_eq!(changes(&session, &app).await, changed(&[("notes.txt", ChangeKind::Modified)]));
}

#[tokio::test]
async fn deletes_a_file_in_the_commit_without_touching_the_working_tree() {
    let machine = Machine::new();
    let app = machine.repo("app");

    let session = machine.connect_local().await;
    session.conn.call::<Commit>(params(&app, &[], &[("README.md", None)], "Remove readme.")).await.unwrap();

    assert_eq!(machine.git(&app, &["ls-tree", "--name-only", "HEAD"]), "");
    assert_eq!(read(&app, "README.md"), "# Project\n");
    assert_eq!(changes(&session, &app).await, changed(&[("README.md", ChangeKind::Untracked)]));

    let error = session.conn.call::<Commit>(params(&app, &[], &[("nope.txt", None)], "Nothing.")).await.unwrap_err();
    assert!(error.to_string().contains("nope.txt"), "{error}");
}

#[tokio::test]
async fn amends_with_given_content_on_top_of_head() {
    let machine = Machine::new();
    let app = machine.repo("app");
    std::fs::write(app.join("README.md"), "# Project\n\nKeep.\nDraft.\n").unwrap();
    std::fs::write(app.join("added.txt"), "added\n").unwrap();

    let session = machine.connect_local().await;
    let amend = CommitParams {
        amend: true,
        ..params(&app, &["added.txt"], &[("README.md", Some("# Project\n\nKeep.\n"))], "Initial commit, amended.")
    };
    session.conn.call::<Commit>(amend).await.unwrap();

    assert_eq!(machine.git(&app, &["rev-list", "--count", "HEAD"]), "1\n");
    assert_eq!(machine.git(&app, &["log", "-1", "--format=%B"]).trim_end(), "Initial commit, amended.");
    assert_eq!(machine.git(&app, &["show", "HEAD:README.md"]), "# Project\n\nKeep.\n");
    assert_eq!(machine.git(&app, &["show", "HEAD:added.txt"]), "added\n");
    assert_eq!(changes(&session, &app).await, changed(&[("README.md", ChangeKind::Modified)]));
}

#[tokio::test]
async fn makes_the_first_commit_from_given_content() {
    let machine = Machine::new();
    let app = machine.home().join("app");
    std::fs::create_dir_all(&app).unwrap();
    machine.git(&app, &["init", "-q"]);
    std::fs::write(app.join("main.rs"), "fn main() {}\nfn extra() {}\n").unwrap();

    let session = machine.connect_local().await;
    session.conn.call::<Commit>(params(&app, &[], &[("main.rs", Some("fn main() {}\n"))], "Start.")).await.unwrap();

    assert_eq!(machine.git(&app, &["show", "HEAD:main.rs"]), "fn main() {}\n");
    assert_eq!(changes(&session, &app).await, changed(&[("main.rs", ChangeKind::Modified)]));
}

#[tokio::test]
async fn keeps_the_executable_bit_and_the_given_line_endings() {
    let machine = Machine::new();
    let app = machine.repo("app");
    machine.git(&app, &["config", "core.autocrlf", "true"]);
    std::fs::write(app.join("run.sh"), "#!/bin/sh\necho one\n").unwrap();
    std::fs::set_permissions(app.join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    machine.git(&app, &["add", "run.sh"]);
    machine.git(&app, &["commit", "-q", "-m", "Add script."]);
    std::fs::write(app.join("run.sh"), "#!/bin/sh\necho one\necho two\n").unwrap();
    std::fs::write(app.join("dos.txt"), "a\r\nb\r\nc\r\n").unwrap();

    let session = machine.connect_local().await;
    let commit = params(
        &app,
        &[],
        &[("run.sh", Some("#!/bin/sh\r\necho one\r\n")), ("dos.txt", Some("a\r\nb\n"))],
        "Line endings.",
    );
    session.conn.call::<Commit>(commit).await.unwrap();

    assert_eq!(machine.git(&app, &["ls-tree", "HEAD", "run.sh"]).split(' ').next(), Some("100755"));
    assert_eq!(machine.git(&app, &["ls-tree", "HEAD", "dos.txt"]).split(' ').next(), Some("100644"));
    assert_eq!(machine.git(&app, &["show", "HEAD:run.sh"]), "#!/bin/sh\r\necho one\r\n");
    assert_eq!(machine.git(&app, &["show", "HEAD:dos.txt"]), "a\r\nb\n");
}

#[tokio::test]
async fn refuses_a_path_given_twice() {
    let machine = Machine::new();
    let app = machine.repo("app");
    std::fs::write(app.join("README.md"), "changed\n").unwrap();
    let session = machine.connect_local().await;

    let both = params(&app, &["README.md"], &[("README.md", Some("x\n"))], "Both.");
    let error = session.conn.call::<Commit>(both).await.unwrap_err();
    assert!(error.to_string().contains("README.md"), "{error}");
    let twice = params(&app, &[], &[("README.md", Some("x\n")), ("README.md", None)], "Twice.");
    let error = session.conn.call::<Commit>(twice).await.unwrap_err();
    assert!(error.to_string().contains("README.md"), "{error}");
    let outside = params(&app, &[], &[("../escape", Some("x\n"))], "Escape.");
    let error = session.conn.call::<Commit>(outside).await.unwrap_err();
    assert!(error.to_string().contains("../escape"), "{error}");

    assert_eq!(machine.git(&app, &["rev-list", "--count", "HEAD"]), "1\n");
}

#[tokio::test]
async fn hooks_see_the_given_content_and_can_stop_the_commit() {
    let machine = Machine::new();
    let app = machine.repo("app");
    std::fs::write(app.join("README.md"), "# Project\n\nKeep.\nDraft.\n").unwrap();
    let hook = app.join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\ngit show :README.md > ../hook-saw.txt\n! grep -q Reject ../hook-saw.txt\n")
        .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();

    let session = machine.connect_local().await;
    session
        .conn
        .call::<Commit>(params(&app, &[], &[("README.md", Some("# Project\n\nKeep.\n"))], "Ok."))
        .await
        .unwrap();
    assert_eq!(std::fs::read_to_string(machine.home().join("hook-saw.txt")).unwrap(), "# Project\n\nKeep.\n");

    let rejected = params(&app, &[], &[("README.md", Some("Reject.\n"))], "Rejected.");
    session.conn.call::<Commit>(rejected).await.unwrap_err();

    assert_eq!(machine.git(&app, &["rev-list", "--count", "HEAD"]), "2\n");
    assert_eq!(read(&app, "README.md"), "# Project\n\nKeep.\nDraft.\n");
    assert_eq!(machine.git(&app, &["diff", "--cached", "--name-only"]), "");
    let leftovers: Vec<_> = std::fs::read_dir(app.join(".git"))
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("gitsense-index"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[tokio::test]
async fn commits_a_whole_file_rename_next_to_partial_content() {
    let machine = Machine::new();
    let app = machine.repo("app");
    std::fs::write(app.join("old.txt"), "content\n").unwrap();
    machine.git(&app, &["add", "old.txt"]);
    machine.git(&app, &["commit", "-q", "-m", "Add old."]);
    machine.git(&app, &["mv", "old.txt", "new.txt"]);
    std::fs::write(app.join("README.md"), "# Project\n\nOne.\nTwo.\n").unwrap();

    let session = machine.connect_local().await;
    let commit = params(&app, &["new.txt", "old.txt"], &[("README.md", Some("# Project\n\nOne.\n"))], "Move.");
    session.conn.call::<Commit>(commit).await.unwrap();

    assert_eq!(machine.git(&app, &["ls-tree", "--name-only", "HEAD"]), "README.md\nnew.txt\n");
    assert_eq!(changes(&session, &app).await, changed(&[("README.md", ChangeKind::Modified)]));
}

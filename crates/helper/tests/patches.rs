mod common;

use std::path::Path;

use common::Machine;
use gitsense_protocol::{
    Blame, BlameParams, ChangeKind, PatchApply, PatchCommitsParams, PatchCreateFromChanges, PatchCreateFromCommits,
    PatchParams, PatchPreview, PathsParams,
};

fn s(path: &Path) -> String {
    path.display().to_string()
}

fn paths(repo: &Path, paths: &[&str]) -> PathsParams {
    PathsParams { repo: s(repo), paths: paths.iter().map(|p| p.to_string()).collect() }
}

fn patch(repo: &Path, text: &str) -> PatchParams {
    PatchParams { repo: s(repo), patch: text.into() }
}

#[tokio::test]
async fn creates_patches_from_changes_including_untracked_and_binary_files() {
    let machine = Machine::new();
    let app = machine.repo("app");
    std::fs::write(app.join("README.md"), "# Project\n\nMore.\n").unwrap();
    std::fs::write(app.join("new.txt"), "new\n").unwrap();
    std::fs::write(app.join("blob.bin"), [0u8, 1, 2, 255]).unwrap();
    std::fs::write(app.join("other.txt"), "left out\n").unwrap();
    machine.git(&app, &["add", "other.txt"]);

    let session = machine.connect_local().await;
    let text =
        session.conn.call::<PatchCreateFromChanges>(paths(&app, &["README.md", "new.txt", "blob.bin"])).await.unwrap();
    assert!(text.contains("+More.") && text.contains("+++ b/new.txt") && text.contains("GIT binary patch"), "{text}");
    assert!(!text.contains("other.txt"));
    // Making the patch leaves the index and working tree alone.
    assert_eq!(machine.git(&app, &["status", "--porcelain"]), " M README.md\nA  other.txt\n?? blob.bin\n?? new.txt\n");

    // The patch applies to a clean checkout and reproduces the files.
    machine.git(&app, &["stash", "-u", "-q"]);
    session.conn.call::<PatchApply>(patch(&app, &text)).await.unwrap();
    assert_eq!(std::fs::read_to_string(app.join("README.md")).unwrap(), "# Project\n\nMore.\n");
    assert_eq!(std::fs::read(app.join("blob.bin")).unwrap(), [0u8, 1, 2, 255]);
    assert_eq!(std::fs::read_to_string(app.join("new.txt")).unwrap(), "new\n");

    let again = session.conn.call::<PatchCreateFromChanges>(paths(&app, &["README.md"])).await.unwrap();
    assert!(again.contains("+More."));
    machine.git(&app, &["checkout", "--", "README.md"]);
    let unchanged = session.conn.call::<PatchCreateFromChanges>(paths(&app, &["README.md"])).await.unwrap();
    assert_eq!(unchanged, "");
}

#[tokio::test]
async fn creates_patches_from_commits_in_order() {
    let machine = Machine::new();
    let app = machine.repo("app");
    for (name, message) in [("one.txt", "Add one."), ("two.txt", "Add two.")] {
        std::fs::write(app.join(name), format!("{name}\n")).unwrap();
        machine.git(&app, &["add", name]);
        machine.git(&app, &["commit", "-q", "-m", message]);
    }

    let session = machine.connect_local().await;
    let params =
        |revs: &[&str]| PatchCommitsParams { repo: s(&app), revs: revs.iter().map(|r| r.to_string()).collect() };
    let text = session.conn.call::<PatchCreateFromCommits>(params(&["HEAD~1", "HEAD"])).await.unwrap();
    let (one, two) = (text.find("Subject: [PATCH] Add one.").unwrap(), text.find("Subject: [PATCH] Add two.").unwrap());
    assert!(one < two);

    session.conn.call::<PatchCreateFromCommits>(params(&[])).await.unwrap_err();
    session.conn.call::<PatchCreateFromCommits>(params(&["--all"])).await.unwrap_err();

    // The patch of both commits applies to a repo that lacks them.
    machine.git(&app, &["reset", "-q", "--hard", "HEAD~2"]);
    session.conn.call::<PatchApply>(patch(&app, &text)).await.unwrap();
    assert_eq!(machine.git(&app, &["status", "--porcelain"]), "A  one.txt\nA  two.txt\n");
}

#[tokio::test]
async fn previews_patches_without_touching_the_repo() {
    let machine = Machine::new();
    let app = machine.repo("app");
    std::fs::write(app.join("old.txt"), "keep\nme\n").unwrap();
    machine.git(&app, &["add", "old.txt"]);
    machine.git(&app, &["commit", "-q", "-m", "Add old."]);
    machine.git(&app, &["mv", "old.txt", "renamed.txt"]);
    std::fs::write(app.join("renamed.txt"), "keep\nme\ntoo\n").unwrap();
    std::fs::write(app.join("README.md"), "# Changed\n").unwrap();
    machine.git(&app, &["add", "-A"]);
    let diff = machine.git(&app, &["diff", "--cached", "--binary", "--full-index", "-M"]);
    machine.git(&app, &["reset", "-q", "--hard"]);

    let session = machine.connect_local().await;
    let files = session.conn.call::<PatchPreview>(patch(&app, &diff)).await.unwrap();

    assert_eq!(files.len(), 2);
    assert_eq!(files[0].path, "README.md");
    assert_eq!(files[0].kind, ChangeKind::Modified);
    assert_eq!(files[0].before.text.as_deref(), Some("# Project\n"));
    assert_eq!(files[0].after.text.as_deref(), Some("# Changed\n"));
    assert_eq!(files[1].path, "renamed.txt");
    assert_eq!(files[1].orig_path.as_deref(), Some("old.txt"));
    assert_eq!(files[1].before.text.as_deref(), Some("keep\nme\n"));
    assert_eq!(files[1].after.text.as_deref(), Some("keep\nme\ntoo\n"));
    assert_eq!(machine.git(&app, &["status", "--porcelain"]), "");
    assert!(app.join("old.txt").exists());

    std::fs::write(app.join("README.md"), "# Other\n").unwrap();
    machine.git(&app, &["commit", "-q", "-a", "-m", "Diverge."]);
    let err = session.conn.call::<PatchPreview>(patch(&app, &diff)).await.unwrap_err();
    assert!(err.to_string().contains("Failed to apply the patch"), "{err}");
}

#[tokio::test]
async fn applies_patches_three_way_and_reports_conflicts() {
    let machine = Machine::new();
    let app = machine.repo("app");
    std::fs::write(app.join("a.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n").unwrap();
    machine.git(&app, &["add", "a.txt"]);
    machine.git(&app, &["commit", "-q", "-m", "Add a."]);
    std::fs::write(app.join("a.txt"), "1\n2\n3\n4\n5\n6\n7\nlast\n").unwrap();
    let session = machine.connect_local().await;
    let text = session.conn.call::<PatchCreateFromChanges>(paths(&app, &["a.txt"])).await.unwrap();
    machine.git(&app, &["checkout", "--", "a.txt"]);

    // A local edit elsewhere in the file merges cleanly and stays unstaged.
    std::fs::write(app.join("a.txt"), "first\n2\n3\n4\n5\n6\n7\n8\n").unwrap();
    session.conn.call::<PatchApply>(patch(&app, &text)).await.unwrap();
    assert_eq!(std::fs::read_to_string(app.join("a.txt")).unwrap(), "first\n2\n3\n4\n5\n6\n7\nlast\n");
    assert_eq!(machine.git(&app, &["status", "--porcelain"]), " M a.txt\n");

    // A local edit of the same line conflicts.
    machine.git(&app, &["checkout", "--", "a.txt"]);
    std::fs::write(app.join("a.txt"), "1\n2\n3\n4\n5\n6\n7\nmine\n").unwrap();
    let err = session.conn.call::<PatchApply>(patch(&app, &text)).await.unwrap_err();
    assert!(err.to_string().contains("conflicts in a.txt"), "{err}");
    let merged = std::fs::read_to_string(app.join("a.txt")).unwrap();
    assert!(merged.contains("<<<<<<<") && merged.contains("mine") && merged.contains("last"), "{merged}");
    assert_eq!(machine.git(&app, &["ls-files", "-u"]).lines().count(), 3);

    // Text that is no patch fails and changes nothing.
    machine.git(&app, &["checkout", "-q", "HEAD", "--", "a.txt"]);
    session.conn.call::<PatchApply>(patch(&app, "not a patch\n")).await.unwrap_err();
    assert_eq!(machine.git(&app, &["status", "--porcelain"]), "");
}

#[tokio::test]
async fn blames_working_tree_lines() {
    let machine = Machine::new();
    let app = machine.repo("app");
    std::fs::write(app.join("a.txt"), "one\ntwo\n").unwrap();
    machine.git(&app, &["add", "a.txt"]);
    machine.git(&app, &["commit", "-q", "-m", "Add a."]);
    let first = machine.git(&app, &["rev-parse", "HEAD"]).trim().to_string();
    std::fs::write(app.join("a.txt"), "one\nTWO\nthree\n").unwrap();
    machine.git(&app, &["commit", "-q", "-a", "-m", "Edit a.\n\nWith a body."]);
    let second = machine.git(&app, &["rev-parse", "HEAD"]).trim().to_string();
    std::fs::write(app.join("a.txt"), "zero\none\nTWO\nthree\nfour\n").unwrap();

    let session = machine.connect_local().await;
    let result = session.conn.call::<Blame>(BlameParams { repo: s(&app), path: "a.txt".into() }).await.unwrap();

    let hashes: Vec<_> = result.commits.iter().map(|c| c.hash.as_str()).collect();
    assert_eq!(hashes, [first.as_str(), second.as_str()]);
    // Lines changed since the last commit have no commit.
    assert_eq!(result.lines, [None, Some(0), Some(1), Some(1), None]);
    assert_eq!(result.commits[0].author_name, "Test User");
    assert_eq!(result.commits[1].summary, "Edit a.");
    assert!(result.commits[1].author_time > 0);

    session.conn.call::<Blame>(BlameParams { repo: s(&app), path: "missing.txt".into() }).await.unwrap_err();
    session.conn.call::<Blame>(BlameParams { repo: s(&app), path: "../a.txt".into() }).await.unwrap_err();
}

#[tokio::test]
async fn applies_a_rename_to_a_file_with_local_edits() {
    let machine = Machine::new();
    let app = machine.repo("app");
    std::fs::write(app.join("caf\u{e9}.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n").unwrap();
    machine.git(&app, &["add", "-A"]);
    machine.git(&app, &["commit", "-q", "-m", "Add file."]);
    machine.git(&app, &["mv", "caf\u{e9}.txt", "tea.txt"]);
    let session = machine.connect_local().await;
    let text = session.conn.call::<PatchCreateFromChanges>(paths(&app, &["caf\u{e9}.txt", "tea.txt"])).await.unwrap();
    machine.git(&app, &["reset", "-q", "--hard"]);

    std::fs::write(app.join("caf\u{e9}.txt"), "first\n2\n3\n4\n5\n6\n7\n8\n").unwrap();
    session.conn.call::<PatchApply>(patch(&app, &text)).await.unwrap();

    assert!(!app.join("caf\u{e9}.txt").exists());
    assert_eq!(std::fs::read_to_string(app.join("tea.txt")).unwrap(), "first\n2\n3\n4\n5\n6\n7\n8\n");
    assert_eq!(
        machine.git(&app, &["-c", "core.quotePath=false", "status", "--porcelain"]),
        "R  caf\u{e9}.txt -> tea.txt\n"
    );
}

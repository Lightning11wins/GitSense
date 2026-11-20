mod common;

use std::path::Path;

use common::Machine;
use gitsense_protocol::{ChangeKind, DiffFiles, DiffFilesParams, Log, LogCommit, LogParams, LogRef, RefKind};

fn s(path: &Path) -> String {
    path.display().to_string()
}

fn params(repo: &Path) -> LogParams {
    LogParams {
        repo: s(repo),
        revs: vec![],
        author: None,
        text: None,
        since: None,
        until: None,
        paths: vec![],
        skip: 0,
        limit: 100,
    }
}

fn commit(machine: &Machine, repo: &Path, file: &str, message: &str, author: &str) -> String {
    std::fs::create_dir_all(repo.join(file).parent().unwrap()).unwrap();
    std::fs::write(repo.join(file), format!("{message}\n")).unwrap();
    machine.git(repo, &["add", file]);
    machine.git(
        repo,
        &["commit", "-q", "-m", message, &format!("--author={author} <{}@example.com>", author.to_lowercase())],
    );
    machine.git(repo, &["rev-parse", "HEAD"]).trim().to_string()
}

fn subjects(commits: &[LogCommit]) -> Vec<&str> {
    commits.iter().map(|c| c.subject.as_str()).collect()
}

#[tokio::test]
async fn lists_commits_of_all_branches_with_their_refs() {
    let machine = Machine::new();
    let origin = machine.repo("origin");
    let repo = machine.home().join("app");
    machine.git(&machine.home(), &["clone", "-q", &s(&origin), &s(&repo)]);
    machine.git(&repo, &["tag", "v1"]);
    machine.git(&repo, &["switch", "-q", "-c", "topic"]);
    let topic = commit(&machine, &repo, "topic.txt", "Add topic.", "Ann");
    machine.git(&repo, &["switch", "-q", "main"]);
    commit(&machine, &repo, "main.txt", "Add main.", "Bob");
    machine.git(&repo, &["merge", "-q", "--no-ff", "-m", "Merge topic.", "topic"]);

    let session = machine.connect_local().await;
    let commits = session.conn.call::<Log>(params(&repo)).await.unwrap();
    assert_eq!(commits.len(), 4);
    let merge = &commits[0];
    assert_eq!(merge.subject, "Merge topic.");
    assert!(merge.head);
    assert_eq!(merge.refs, [LogRef { kind: RefKind::Local, name: "main".into() }]);
    assert_eq!(merge.parents.len(), 2);
    assert_eq!(merge.parents[1], topic);
    assert!(commits[1..].iter().all(|c| !c.head));
    let initial = commits.last().unwrap();
    assert_eq!(initial.subject, "Initial commit.");
    assert!(initial.parents.is_empty());
    let mut refs: Vec<_> = initial.refs.iter().map(|r| (r.kind, r.name.as_str())).collect();
    refs.sort_by_key(|r| r.1);
    assert_eq!(refs, [(RefKind::Remote, "origin/main"), (RefKind::Tag, "v1")]);
    assert_eq!(commits.iter().find(|c| c.hash == topic).unwrap().refs[0].name, "topic");
    let position = |hash: &str| commits.iter().position(|c| c.hash == hash).unwrap();
    for (i, c) in commits.iter().enumerate() {
        assert!(c.parents.iter().all(|p| position(p) > i), "{} comes after a parent", c.subject);
    }

    let page = session.conn.call::<Log>(LogParams { skip: 1, limit: 2, ..params(&repo) }).await.unwrap();
    assert_eq!(page, commits[1..3]);
    let topic_only = session.conn.call::<Log>(LogParams { revs: vec!["topic".into()], ..params(&repo) }).await.unwrap();
    assert_eq!(subjects(&topic_only), ["Add topic.", "Initial commit."]);
}

#[tokio::test]
async fn filters_by_author_text_hash_path_and_date() {
    let machine = Machine::new();
    let repo = machine.repo("app");
    let fix = commit(&machine, &repo, "src/lib.rs", "Fix the parser.", "Ann");
    commit(&machine, &repo, "docs/guide.md", "Document the parser.", "Bob");
    commit(&machine, &repo, "src/main.rs", "Add a flag (with [brackets]).", "Bob");

    let session = machine.connect_local().await;
    let log = |p: LogParams| session.conn.call::<Log>(p);
    let by_bob = log(LogParams { author: Some("bob@EXAMPLE".into()), ..params(&repo) }).await.unwrap();
    assert_eq!(subjects(&by_bob), ["Add a flag (with [brackets]).", "Document the parser."]);
    let parser = log(LogParams { text: Some("PARSER".into()), ..params(&repo) }).await.unwrap();
    assert_eq!(subjects(&parser), ["Document the parser.", "Fix the parser."]);
    let literal = log(LogParams { text: Some("[brackets]".into()), ..params(&repo) }).await.unwrap();
    assert_eq!(subjects(&literal), ["Add a flag (with [brackets])."]);
    let by_hash = log(LogParams { text: Some(fix[..8].into()), ..params(&repo) }).await.unwrap();
    assert_eq!(subjects(&by_hash), ["Fix the parser."]);
    let in_src = log(LogParams { paths: vec!["src".into()], ..params(&repo) }).await.unwrap();
    assert_eq!(subjects(&in_src), ["Add a flag (with [brackets]).", "Fix the parser."]);
    let both = log(LogParams { author: Some("bob".into()), paths: vec!["src".into()], ..params(&repo) }).await.unwrap();
    assert_eq!(subjects(&both), ["Add a flag (with [brackets])."]);

    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let recent = log(LogParams { since: Some(now - 3600), ..params(&repo) }).await.unwrap();
    assert_eq!(recent.len(), 4);
    let future = log(LogParams { since: Some(now + 3600), ..params(&repo) }).await.unwrap();
    assert!(future.is_empty());
    let old = log(LogParams { until: Some(now - 3600), ..params(&repo) }).await.unwrap();
    assert!(old.is_empty());

    let outside = log(LogParams { paths: vec!["../x".into()], ..params(&repo) }).await;
    assert!(outside.is_err());
}

#[tokio::test]
async fn lists_files_between_revisions_or_from_the_empty_tree() {
    let machine = Machine::new();
    let repo = machine.repo("app");
    let first = machine.git(&repo, &["rev-parse", "HEAD"]).trim().to_string();
    commit(&machine, &repo, "a.txt", "Add a.", "Ann");
    machine.git(&repo, &["mv", "README.md", "README.txt"]);
    machine.git(&repo, &["commit", "-q", "-m", "Rename the readme."]);
    commit(&machine, &repo, "b.txt", "Add b.", "Ann");

    let session = machine.connect_local().await;
    let files = |from: Option<&str>, to: &str| {
        session.conn.call::<DiffFiles>(DiffFilesParams { repo: s(&repo), from: from.map(String::from), to: to.into() })
    };
    let mut changes = files(Some(&first), "HEAD").await.unwrap();
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    let summary: Vec<_> = changes.iter().map(|c| (c.path.as_str(), c.orig_path.as_deref(), c.kind)).collect();
    assert_eq!(
        summary,
        [
            ("README.txt", Some("README.md"), ChangeKind::Renamed),
            ("a.txt", None, ChangeKind::Added),
            ("b.txt", None, ChangeKind::Added),
        ]
    );
    let root = files(None, &first).await.unwrap();
    assert_eq!(root.len(), 1);
    assert_eq!((root[0].path.as_str(), root[0].kind), ("README.md", ChangeKind::Added));
}

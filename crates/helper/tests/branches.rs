mod common;

use std::path::{Path, PathBuf};

use common::{Machine, Session};
use gitsense_protocol::{
    BranchCreate, BranchCreateParams, BranchDelete, BranchDeleteParams, BranchParams, BranchRename, BranchRenameParams,
    BranchUpdate, BranchesList, ChangeKind, Checkout, CheckoutParams, CheckoutTarget, CommitFiles, Fetch, LocalBranch,
    Merge, Pull, Push, PushOutgoing, PushParams, PushTargetParams, Rebase, RebaseParams, RemoteBranch, RepoParams,
    RevParams, WorktreeRemove, WorktreeRemoveParams, WorktreesList,
};

fn s(path: &Path) -> String {
    path.display().to_string()
}

/// A bare `origin.git` with one commit, and a clone of it at `app`.
fn clone(machine: &Machine) -> (PathBuf, PathBuf) {
    let seed = machine.repo("seed");
    let origin = machine.home().join("origin.git");
    machine.git(&machine.home(), &["clone", "-q", "--bare", &s(&seed), &s(&origin)]);
    let app = machine.home().join("app");
    machine.git(&machine.home(), &["clone", "-q", &s(&origin), &s(&app)]);
    (origin, app)
}

/// Commits a new file in `repo` and returns the commit hash.
fn commit_file(machine: &Machine, repo: &Path, name: &str) -> String {
    std::fs::write(repo.join(name), format!("{name}\n")).unwrap();
    machine.git(repo, &["add", name]);
    machine.git(repo, &["commit", "-q", "-m", &format!("Add {name}.")]);
    machine.git(repo, &["rev-parse", "HEAD"]).trim().to_string()
}

fn repo_params(repo: &Path) -> RepoParams {
    RepoParams { repo: s(repo) }
}

async fn local_branch(session: &Session, repo: &Path, name: &str) -> Option<LocalBranch> {
    let branches = session.conn.call::<BranchesList>(repo_params(repo)).await.unwrap();
    branches.local.into_iter().find(|b| b.name == name)
}

fn head_branch(machine: &Machine, repo: &Path) -> String {
    machine.git(repo, &["branch", "--show-current"]).trim().to_string()
}

#[tokio::test]
async fn lists_branches_with_upstream_tracking_after_fetch() {
    let machine = Machine::new();
    let (origin, app) = clone(&machine);
    let other = machine.home().join("other");
    machine.git(&machine.home(), &["clone", "-q", &s(&origin), &s(&other)]);
    commit_file(&machine, &other, "theirs.txt");
    machine.git(&other, &["push", "-q", "origin", "main"]);
    commit_file(&machine, &app, "ours.txt");
    machine.git(&app, &["branch", "topic"]);

    let session = machine.connect_local().await;
    session.conn.call::<Fetch>(repo_params(&app)).await.unwrap();
    let branches = session.conn.call::<BranchesList>(repo_params(&app)).await.unwrap();

    assert_eq!(
        branches.local,
        [
            LocalBranch {
                name: "main".into(),
                upstream: Some("origin/main".into()),
                upstream_gone: false,
                ahead: 1,
                behind: 1,
                current: true,
                worktree: Some(s(&app)),
            },
            LocalBranch {
                name: "topic".into(),
                upstream: None,
                upstream_gone: false,
                ahead: 0,
                behind: 0,
                current: false,
                worktree: None,
            },
        ]
    );
    assert_eq!(branches.remote, [RemoteBranch { remote: "origin".into(), name: "main".into() }]);
}

#[tokio::test]
async fn creates_checks_out_renames_and_deletes_branches() {
    let machine = Machine::new();
    let app = machine.repo("app");
    let first = machine.git(&app, &["rev-parse", "HEAD"]).trim().to_string();
    commit_file(&machine, &app, "second.txt");
    let session = machine.connect_local().await;
    let repo = s(&app);

    let create = |name: &str, start: &str, checkout| BranchCreateParams {
        repo: repo.clone(),
        name: name.into(),
        start: start.into(),
        checkout,
    };
    session.conn.call::<BranchCreate>(create("old", &first, false)).await.unwrap();
    assert_eq!(head_branch(&machine, &app), "main");
    session.conn.call::<BranchCreate>(create("feature", "main", true)).await.unwrap();
    assert_eq!(head_branch(&machine, &app), "feature");

    let checkout = |target| CheckoutParams { repo: repo.clone(), target };
    session.conn.call::<Checkout>(checkout(CheckoutTarget::Branch { name: "old".into() })).await.unwrap();
    assert_eq!(machine.git(&app, &["rev-parse", "HEAD"]).trim(), first);
    session.conn.call::<Checkout>(checkout(CheckoutTarget::Revision { rev: "main".into() })).await.unwrap();
    assert_eq!(head_branch(&machine, &app), "");

    let rename = BranchRenameParams { repo: repo.clone(), from: "feature".into(), to: "renamed".into() };
    session.conn.call::<BranchRename>(rename).await.unwrap();
    assert!(local_branch(&session, &app, "renamed").await.is_some());

    let delete = |name: &str, force| BranchDeleteParams { repo: repo.clone(), name: name.into(), remote: None, force };
    session.conn.call::<BranchDelete>(delete("renamed", false)).await.unwrap();
    // `old` is behind HEAD, so it counts as merged.
    session.conn.call::<BranchDelete>(delete("old", false)).await.unwrap();
    let names: Vec<String> =
        session.conn.call::<BranchesList>(repo_params(&app)).await.unwrap().local.into_iter().map(|b| b.name).collect();
    assert_eq!(names, ["main"]);

    let bad = session.conn.call::<BranchCreate>(create("-f", "main", false)).await.unwrap_err();
    assert!(bad.to_string().contains("'-f'"), "{bad}");
}

#[tokio::test]
async fn refuses_to_delete_an_unmerged_branch_unless_forced() {
    let machine = Machine::new();
    let app = machine.repo("app");
    machine.git(&app, &["switch", "-q", "-c", "work"]);
    commit_file(&machine, &app, "work.txt");
    machine.git(&app, &["switch", "-q", "main"]);
    let session = machine.connect_local().await;

    let delete = |force| BranchDeleteParams { repo: s(&app), name: "work".into(), remote: None, force };
    session.conn.call::<BranchDelete>(delete(false)).await.unwrap_err();
    assert!(local_branch(&session, &app, "work").await.is_some());
    session.conn.call::<BranchDelete>(delete(true)).await.unwrap();
    assert!(local_branch(&session, &app, "work").await.is_none());
}

#[tokio::test]
async fn pushes_a_new_branch_and_lists_outgoing_commits() {
    let machine = Machine::new();
    let (origin, app) = clone(&machine);
    machine.git(&app, &["switch", "-q", "-c", "feature"]);
    let first = commit_file(&machine, &app, "one.txt");
    let second = commit_file(&machine, &app, "two.txt");
    let session = machine.connect_local().await;

    let target = PushTargetParams {
        repo: s(&app),
        branch: "feature".into(),
        remote: "origin".into(),
        remote_branch: "feature".into(),
    };
    let outgoing = session.conn.call::<PushOutgoing>(target.clone()).await.unwrap();
    let hashes: Vec<&str> = outgoing.iter().map(|c| c.hash.as_str()).collect();
    assert_eq!(hashes, [second.as_str(), first.as_str()]);
    assert_eq!(outgoing[0].subject, "Add two.txt.");
    assert_eq!(outgoing[0].author_email, "test@example.com");

    let push = PushParams {
        repo: s(&app),
        branch: "feature".into(),
        remote: "origin".into(),
        remote_branch: "feature".into(),
        set_upstream: true,
        force_with_lease: false,
    };
    session.conn.call::<Push>(push.clone()).await.unwrap();
    assert_eq!(machine.git(&origin, &["rev-parse", "feature"]).trim(), second);
    assert_eq!(local_branch(&session, &app, "feature").await.unwrap().upstream.as_deref(), Some("origin/feature"));
    assert_eq!(session.conn.call::<PushOutgoing>(target).await.unwrap(), []);

    machine.git(&app, &["commit", "-q", "--amend", "-m", "Rewrite."]);
    session.conn.call::<Push>(push.clone()).await.unwrap_err();
    session.conn.call::<Push>(PushParams { force_with_lease: true, ..push }).await.unwrap();
    assert_eq!(machine.git(&origin, &["log", "-1", "--format=%s", "feature"]).trim(), "Rewrite.");

    let delete =
        BranchDeleteParams { repo: s(&app), name: "feature".into(), remote: Some("origin".into()), force: false };
    session.conn.call::<BranchDelete>(delete).await.unwrap();
    assert_eq!(machine.git(&origin, &["branch", "--list", "feature"]), "");
}

#[tokio::test]
async fn pulls_the_current_branch_and_updates_another() {
    let machine = Machine::new();
    let (origin, app) = clone(&machine);
    let other = machine.home().join("other");
    machine.git(&machine.home(), &["clone", "-q", &s(&origin), &s(&other)]);
    machine.git(&other, &["switch", "-q", "-c", "topic"]);
    machine.git(&other, &["push", "-q", "origin", "topic"]);
    machine.git(&app, &["fetch", "-q"]);
    machine.git(&app, &["branch", "topic", "--track", "origin/topic"]);
    let topic = commit_file(&machine, &other, "topic.txt");
    machine.git(&other, &["push", "-q", "origin", "topic"]);
    machine.git(&other, &["switch", "-q", "main"]);
    let main = commit_file(&machine, &other, "main.txt");
    machine.git(&other, &["push", "-q", "origin", "main"]);
    // Local changes survive the pull.
    std::fs::write(app.join("README.md"), "# Edited\n").unwrap();

    let session = machine.connect_local().await;
    session.conn.call::<Pull>(repo_params(&app)).await.unwrap();
    assert_eq!(machine.git(&app, &["rev-parse", "HEAD"]).trim(), main);
    assert_eq!(std::fs::read_to_string(app.join("README.md")).unwrap(), "# Edited\n");

    session.conn.call::<BranchUpdate>(BranchParams { repo: s(&app), branch: "topic".into() }).await.unwrap();
    assert_eq!(machine.git(&app, &["rev-parse", "topic"]).trim(), topic);
    let err = session.conn.call::<BranchUpdate>(BranchParams { repo: s(&app), branch: "-x".into() }).await;
    err.unwrap_err();
}

#[tokio::test]
async fn merges_and_rebases_branches() {
    let machine = Machine::new();
    let app = machine.repo("app");
    machine.git(&app, &["switch", "-q", "-c", "feature"]);
    commit_file(&machine, &app, "feature.txt");
    machine.git(&app, &["switch", "-q", "main"]);
    commit_file(&machine, &app, "main.txt");
    let session = machine.connect_local().await;

    let rebase = RebaseParams { repo: s(&app), onto: "main".into(), branch: Some("feature".into()) };
    session.conn.call::<Rebase>(rebase).await.unwrap();
    assert_eq!(head_branch(&machine, &app), "feature");
    assert_eq!(machine.git(&app, &["rev-parse", "HEAD~1"]), machine.git(&app, &["rev-parse", "main"]));

    machine.git(&app, &["switch", "-q", "main"]);
    session.conn.call::<Merge>(RevParams { repo: s(&app), rev: "feature".into() }).await.unwrap();
    assert_eq!(machine.git(&app, &["rev-parse", "HEAD"]), machine.git(&app, &["rev-parse", "feature"]));
}

#[tokio::test]
async fn lists_files_of_root_normal_and_merge_commits() {
    let machine = Machine::new();
    let app = machine.repo("app");
    let session = machine.connect_local().await;
    let files = |rev: &str| {
        let params = RevParams { repo: s(&app), rev: rev.into() };
        let session = &session;
        async move {
            let list = session.conn.call::<CommitFiles>(params).await.unwrap();
            list.into_iter().map(|c| (c.path, c.orig_path, c.kind)).collect::<Vec<_>>()
        }
    };
    assert_eq!(files("HEAD").await, [("README.md".into(), None, ChangeKind::Added)]);

    machine.git(&app, &["mv", "README.md", "README.txt"]);
    std::fs::write(app.join("new.txt"), "new\n").unwrap();
    machine.git(&app, &["add", "new.txt"]);
    machine.git(&app, &["commit", "-q", "-m", "Rename."]);
    assert_eq!(
        files("HEAD").await,
        [
            ("README.txt".into(), Some("README.md".into()), ChangeKind::Renamed),
            ("new.txt".into(), None, ChangeKind::Added),
        ]
    );

    machine.git(&app, &["switch", "-q", "-c", "side", "HEAD~1"]);
    commit_file(&machine, &app, "side.txt");
    machine.git(&app, &["switch", "-q", "main"]);
    machine.git(&app, &["merge", "-q", "--no-edit", "side"]);
    assert_eq!(files("HEAD").await, [("side.txt".into(), None, ChangeKind::Added)]);
}

#[tokio::test]
async fn removes_worktrees_only_when_safe_unless_forced() {
    let machine = Machine::new();
    let app = machine.repo("app");
    let tree = machine.home().join("app-agent");
    machine.git(&app, &["worktree", "add", "-q", "-b", "agent", &s(&tree)]);
    commit_file(&machine, &tree, "agent.txt");
    let session = machine.connect_local().await;

    let worktrees = session.conn.call::<WorktreesList>(repo_params(&app)).await.unwrap();
    let summary: Vec<_> = worktrees.iter().map(|w| (w.path.clone(), w.branch.clone(), w.is_main, w.unmerged)).collect();
    assert_eq!(summary, [(s(&app), Some("main".into()), true, 0), (s(&tree), Some("agent".into()), false, 1)]);

    let remove = |force| WorktreeRemoveParams { repo: s(&app), path: s(&tree), force, delete_branch: true };
    let err = session.conn.call::<WorktreeRemove>(remove(false)).await.unwrap_err();
    assert!(err.to_string().contains("1 commit(s)"), "{err}");

    machine.git(&app, &["merge", "-q", "agent"]);
    std::fs::write(tree.join("agent.txt"), "edited\n").unwrap();
    let err = session.conn.call::<WorktreeRemove>(remove(false)).await.unwrap_err();
    assert!(err.to_string().contains("uncommitted changes"), "{err}");

    machine.git(&tree, &["checkout", "--", "agent.txt"]);
    session.conn.call::<WorktreeRemove>(remove(false)).await.unwrap();
    assert!(!tree.exists());
    assert!(local_branch(&session, &app, "agent").await.is_none());

    let main = WorktreeRemoveParams { repo: s(&app), path: s(&app), force: true, delete_branch: false };
    session.conn.call::<WorktreeRemove>(main).await.unwrap_err();
}

#[tokio::test]
async fn force_removes_a_dirty_worktree_with_unmerged_commits() {
    let machine = Machine::new();
    let app = machine.repo("app");
    let tree = machine.home().join("app-agent");
    machine.git(&app, &["worktree", "add", "-q", "-b", "agent", &s(&tree)]);
    commit_file(&machine, &tree, "agent.txt");
    std::fs::write(tree.join("scratch.txt"), "scratch\n").unwrap();
    let session = machine.connect_local().await;

    let remove = WorktreeRemoveParams { repo: s(&app), path: s(&tree), force: true, delete_branch: false };
    session.conn.call::<WorktreeRemove>(remove).await.unwrap();
    assert!(!tree.exists());
    assert!(local_branch(&session, &app, "agent").await.is_some());
}

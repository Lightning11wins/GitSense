mod common;

use std::path::Path;

use common::{Machine, Session};
use gitsense_protocol::{
    ChangelistDeleteParams, ChangelistParams, ChangelistPathsParams, ChangelistRenameParams, Changelists,
    ChangelistsCreate, ChangelistsDelete, ChangelistsGet, ChangelistsMovePaths, ChangelistsRename,
    ChangelistsSetActive, RepoParams,
};

fn repo_params(repo: &Path) -> RepoParams {
    RepoParams { repo: repo.display().to_string() }
}

fn named(repo: &Path, name: &str) -> ChangelistParams {
    ChangelistParams { repo: repo.display().to_string(), name: name.into() }
}

fn moved(repo: &Path, name: &str, paths: &[&str]) -> ChangelistPathsParams {
    ChangelistPathsParams {
        repo: repo.display().to_string(),
        name: name.into(),
        paths: paths.iter().map(|p| p.to_string()).collect(),
    }
}

/// Each list's name and paths, in order.
fn summary(lists: &Changelists) -> Vec<(&str, Vec<&str>)> {
    lists.lists.iter().map(|l| (l.name.as_str(), l.paths.iter().map(String::as_str).collect())).collect()
}

async fn get(session: &Session, repo: &Path) -> Changelists {
    session.conn.call::<ChangelistsGet>(repo_params(repo)).await.unwrap()
}

/// A repo with two modified files, `a.txt` and `b.txt`, and one untracked `c.txt`.
fn changed_repo(machine: &Machine) -> std::path::PathBuf {
    let app = machine.repo("app");
    for name in ["a.txt", "b.txt"] {
        std::fs::write(app.join(name), "one\n").unwrap();
        machine.git(&app, &["add", name]);
    }
    machine.git(&app, &["commit", "-q", "-m", "Add files."]);
    for name in ["a.txt", "b.txt", "c.txt"] {
        std::fs::write(app.join(name), "two\n").unwrap();
    }
    app
}

#[tokio::test]
async fn starts_with_an_active_default_list() {
    let machine = Machine::new();
    let app = machine.repo("app");
    let session = machine.connect_local().await;

    let lists = get(&session, &app).await;

    assert_eq!(lists.active, lists.lists[0].name);
    assert_eq!(lists.lists.len(), 1);
    assert!(lists.lists[0].is_default);
}

#[tokio::test]
async fn creates_moves_renames_and_activates_lists() {
    let machine = Machine::new();
    let app = changed_repo(&machine);
    let session = machine.connect_local().await;
    let default = get(&session, &app).await.active;

    session.conn.call::<ChangelistsCreate>(named(&app, "Feature")).await.unwrap();
    session.conn.call::<ChangelistsMovePaths>(moved(&app, "Feature", &["a.txt", "c.txt"])).await.unwrap();
    let lists = session.conn.call::<ChangelistsMovePaths>(moved(&app, &default, &["c.txt"])).await.unwrap();
    assert_eq!(summary(&lists), [(default.as_str(), vec!["c.txt"]), ("Feature", vec!["a.txt"])]);

    session.conn.call::<ChangelistsSetActive>(named(&app, "Feature")).await.unwrap();
    let rename =
        ChangelistRenameParams { repo: app.display().to_string(), name: "Feature".into(), new_name: "Fix".into() };
    let lists = session.conn.call::<ChangelistsRename>(rename).await.unwrap();

    assert_eq!(lists.active, "Fix");
    assert_eq!(summary(&lists), [(default.as_str(), vec!["c.txt"]), ("Fix", vec!["a.txt"])]);
    assert_eq!(get(&session, &app).await, lists);
}

#[tokio::test]
async fn keeps_lists_across_helper_sessions() {
    let machine = Machine::new();
    let app = changed_repo(&machine);
    let other = machine.repo("other");
    let first = machine.connect_local().await;
    first.conn.call::<ChangelistsCreate>(named(&app, "Feature")).await.unwrap();
    first.conn.call::<ChangelistsMovePaths>(moved(&app, "Feature", &["b.txt"])).await.unwrap();
    first.conn.call::<ChangelistsSetActive>(named(&app, "Feature")).await.unwrap();
    let before = get(&first, &app).await;
    drop(first);

    let second = machine.connect_local().await;

    assert_eq!(get(&second, &app).await, before);
    assert_eq!(get(&second, &other).await.lists.len(), 1);
}

#[tokio::test]
async fn default_list_cannot_be_deleted_but_can_be_renamed() {
    let machine = Machine::new();
    let app = machine.repo("app");
    let session = machine.connect_local().await;
    let default = get(&session, &app).await.active;

    let delete = ChangelistDeleteParams { repo: app.display().to_string(), name: default.clone(), move_to: None };
    let error = session.conn.call::<ChangelistsDelete>(delete).await.unwrap_err();
    assert!(error.to_string().contains(&default), "{error}");

    let rename = ChangelistRenameParams { repo: app.display().to_string(), name: default, new_name: "Main".into() };
    let lists = session.conn.call::<ChangelistsRename>(rename).await.unwrap();
    assert_eq!((lists.active.as_str(), lists.lists[0].is_default), ("Main", true));
}

#[tokio::test]
async fn deleting_a_list_moves_its_files_to_the_default_or_a_given_list() {
    let machine = Machine::new();
    let app = changed_repo(&machine);
    let session = machine.connect_local().await;
    let default = get(&session, &app).await.active;
    for name in ["One", "Two", "Three"] {
        session.conn.call::<ChangelistsCreate>(named(&app, name)).await.unwrap();
    }
    session.conn.call::<ChangelistsMovePaths>(moved(&app, "One", &["a.txt"])).await.unwrap();
    session.conn.call::<ChangelistsMovePaths>(moved(&app, "Two", &["b.txt"])).await.unwrap();
    session.conn.call::<ChangelistsMovePaths>(moved(&app, "Three", &["c.txt"])).await.unwrap();
    session.conn.call::<ChangelistsSetActive>(named(&app, "Two")).await.unwrap();
    let delete = |name: &str, move_to: Option<&str>| ChangelistDeleteParams {
        repo: app.display().to_string(),
        name: name.into(),
        move_to: move_to.map(String::from),
    };

    session.conn.call::<ChangelistsDelete>(delete("One", None)).await.unwrap();
    let lists = session.conn.call::<ChangelistsDelete>(delete("Two", Some("Three"))).await.unwrap();

    assert_eq!(summary(&lists), [(default.as_str(), vec!["a.txt"]), ("Three", vec!["b.txt", "c.txt"])]);
    assert_eq!(lists.active, "Three");

    let error = session.conn.call::<ChangelistsDelete>(delete("Three", Some("Three"))).await.unwrap_err();
    assert!(error.to_string().contains("Three"), "{error}");
    let error = session.conn.call::<ChangelistsDelete>(delete("Three", Some("Missing"))).await.unwrap_err();
    assert!(error.to_string().contains("Missing"), "{error}");
}

#[tokio::test]
async fn rejects_empty_duplicate_and_unknown_names() {
    let machine = Machine::new();
    let app = machine.repo("app");
    let session = machine.connect_local().await;
    session.conn.call::<ChangelistsCreate>(named(&app, "Feature")).await.unwrap();

    let error = session.conn.call::<ChangelistsCreate>(named(&app, "Feature")).await.unwrap_err();
    assert!(error.to_string().contains("Feature"), "{error}");
    let error = session.conn.call::<ChangelistsCreate>(named(&app, "  ")).await.unwrap_err();
    assert!(error.to_string().starts_with("Failed to"), "{error}");
    let error = session.conn.call::<ChangelistsSetActive>(named(&app, "Missing")).await.unwrap_err();
    assert!(error.to_string().contains("Missing"), "{error}");
    let error = session.conn.call::<ChangelistsMovePaths>(moved(&app, "Feature", &["../escape"])).await.unwrap_err();
    assert!(error.to_string().contains("../escape"), "{error}");
    let rename =
        ChangelistRenameParams { repo: app.display().to_string(), name: "Feature".into(), new_name: "Feature".into() };
    session.conn.call::<ChangelistsRename>(rename).await.unwrap();
}

#[tokio::test]
async fn forgets_files_that_no_longer_have_changes() {
    let machine = Machine::new();
    let app = changed_repo(&machine);
    let session = machine.connect_local().await;
    session.conn.call::<ChangelistsCreate>(named(&app, "Feature")).await.unwrap();
    session.conn.call::<ChangelistsMovePaths>(moved(&app, "Feature", &["a.txt", "b.txt"])).await.unwrap();
    machine.git(&app, &["checkout", "--", "a.txt"]);

    let lists = get(&session, &app).await;

    assert_eq!(summary(&lists)[1], ("Feature", vec!["b.txt"]));
}

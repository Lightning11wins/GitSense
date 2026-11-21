//! `gitsense-helper`: runs on the machine being managed and serves the
//! GitSense protocol on stdin/stdout.

mod branches;
mod changelists;
mod changes;
mod commit;
mod commit_actions;
mod compare;
mod conflicts;
mod error;
mod files;
mod git;
mod log;
mod ops;
mod paths;
mod remote;
mod repos;
mod status;
mod watch;
mod worktrees;

use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

use gitsense_protocol::{Event, HelperMessage, Method, Request};
use serde_json::Value;

pub use error::{Error, Result};

/// Shared state for request handlers.
pub struct Ctx {
    pub out: Output,
    pub paths: paths::Paths,
    pub repos: Mutex<repos::Store>,
    pub watcher: Mutex<Option<watch::Watcher>>,
}

impl Ctx {
    pub fn send(&self, message: &HelperMessage) {
        self.out.send(message);
    }

    pub fn event(&self, event: Event) {
        self.out.event(event);
    }
}

/// The helper's stdout, shared by request threads and the file watcher.
#[derive(Clone)]
pub struct Output(Arc<Mutex<std::io::Stdout>>);

impl Output {
    pub fn send(&self, message: &HelperMessage) {
        let mut line = serde_json::to_string(message).expect("Failed to serialize a helper message");
        line.push('\n');
        let mut out = self.0.lock().unwrap();
        // A closed stdout means the app is gone; the stdin loop ends soon after.
        let _ = out.write_all(line.as_bytes()).and_then(|()| out.flush());
    }

    pub fn event(&self, event: Event) {
        self.send(&HelperMessage::Event { event });
    }
}

fn main() {
    let paths = match paths::Paths::from_env() {
        Ok(paths) => paths,
        Err(e) => {
            eprintln!("gitsense-helper: {e}");
            std::process::exit(1);
        }
    };
    paths.prune_old_helpers();
    let ctx = Arc::new(Ctx {
        out: Output(Arc::new(Mutex::new(std::io::stdout()))),
        repos: Mutex::new(repos::Store::load(&paths)),
        paths,
        watcher: Mutex::new(None),
    });

    ctx.event(Event::Ready {
        helper_version: env!("CARGO_PKG_VERSION").to_string(),
        git_version: git::version().unwrap_or_else(|e| format!("unknown ({e})")),
        home: ctx.paths.home.display().to_string(),
    });

    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(e) => {
                eprintln!("gitsense-helper: Failed to parse request {line:?}: {e}");
                continue;
            }
        };
        let ctx = ctx.clone();
        std::thread::spawn(move || {
            let id = request.id;
            let message = match dispatch(&ctx, request) {
                Ok(result) => HelperMessage::Response { id, result },
                Err(e) => HelperMessage::Error { id, message: e.to_string() },
            };
            ctx.send(&message);
        });
    }
}

fn dispatch(ctx: &Ctx, request: Request) -> Result<Value> {
    use gitsense_protocol as p;
    let params = request.params;
    match request.method.as_str() {
        p::ReposList::NAME => call::<p::ReposList>(ctx, params, repos::list),
        p::ReposScan::NAME => call::<p::ReposScan>(ctx, params, repos::scan),
        p::ReposAdd::NAME => call::<p::ReposAdd>(ctx, params, repos::add),
        p::ReposSetHidden::NAME => call::<p::ReposSetHidden>(ctx, params, repos::set_hidden),
        p::Status::NAME => call::<p::Status>(ctx, params, status::status),
        p::FileRead::NAME => call::<p::FileRead>(ctx, params, files::read),
        p::FileWrite::NAME => call::<p::FileWrite>(ctx, params, files::write),
        p::Commit::NAME => call::<p::Commit>(ctx, params, commit::commit),
        p::CommitMessage::NAME => call::<p::CommitMessage>(ctx, params, commit::message),
        p::Rollback::NAME => call::<p::Rollback>(ctx, params, changes::rollback),
        p::FilesAdd::NAME => call::<p::FilesAdd>(ctx, params, changes::add),
        p::FilesDelete::NAME => call::<p::FilesDelete>(ctx, params, changes::delete_files),
        p::IgnoreTargets::NAME => call::<p::IgnoreTargets>(ctx, params, changes::ignore_targets),
        p::IgnoreAdd::NAME => call::<p::IgnoreAdd>(ctx, params, changes::ignore_add),
        p::CommitFiles::NAME => call::<p::CommitFiles>(ctx, params, commit::files),
        p::Log::NAME => call::<p::Log>(ctx, params, log::log),
        p::DiffFiles::NAME => call::<p::DiffFiles>(ctx, params, log::diff_files),
        p::BranchesList::NAME => call::<p::BranchesList>(ctx, params, branches::list),
        p::Checkout::NAME => call::<p::Checkout>(ctx, params, branches::checkout),
        p::BranchCreate::NAME => call::<p::BranchCreate>(ctx, params, branches::create),
        p::BranchRename::NAME => call::<p::BranchRename>(ctx, params, branches::rename),
        p::BranchDelete::NAME => call::<p::BranchDelete>(ctx, params, branches::delete),
        p::BranchUpdate::NAME => call::<p::BranchUpdate>(ctx, params, branches::update),
        p::Merge::NAME => call::<p::Merge>(ctx, params, branches::merge),
        p::Rebase::NAME => call::<p::Rebase>(ctx, params, branches::rebase),
        p::RemotesList::NAME => call::<p::RemotesList>(ctx, params, branches::list_remotes),
        p::Fetch::NAME => call::<p::Fetch>(ctx, params, remote::fetch),
        p::Pull::NAME => call::<p::Pull>(ctx, params, remote::pull),
        p::PushOutgoing::NAME => call::<p::PushOutgoing>(ctx, params, remote::outgoing),
        p::Push::NAME => call::<p::Push>(ctx, params, remote::push),
        p::WorktreesList::NAME => call::<p::WorktreesList>(ctx, params, worktrees::list),
        p::WorktreeRemove::NAME => call::<p::WorktreeRemove>(ctx, params, worktrees::remove),
        // Changelists and partial commits.
        p::ChangelistsGet::NAME => call::<p::ChangelistsGet>(ctx, params, changelists::get),
        p::ChangelistsCreate::NAME => call::<p::ChangelistsCreate>(ctx, params, changelists::create),
        p::ChangelistsRename::NAME => call::<p::ChangelistsRename>(ctx, params, changelists::rename),
        p::ChangelistsDelete::NAME => call::<p::ChangelistsDelete>(ctx, params, changelists::delete),
        p::ChangelistsSetActive::NAME => call::<p::ChangelistsSetActive>(ctx, params, changelists::set_active),
        p::ChangelistsMovePaths::NAME => call::<p::ChangelistsMovePaths>(ctx, params, changelists::move_paths),
        // Operations, conflicts, comparison, commit actions.
        p::OperationContinue::NAME => call::<p::OperationContinue>(ctx, params, ops::continue_operation),
        p::OperationAbort::NAME => call::<p::OperationAbort>(ctx, params, ops::abort_operation),
        p::OperationSkip::NAME => call::<p::OperationSkip>(ctx, params, ops::skip_operation),
        p::CherryPick::NAME => call::<p::CherryPick>(ctx, params, ops::cherry_pick),
        p::Revert::NAME => call::<p::Revert>(ctx, params, ops::revert),
        p::Reset::NAME => call::<p::Reset>(ctx, params, ops::reset),
        p::CommitReword::NAME => call::<p::CommitReword>(ctx, params, commit_actions::reword),
        p::CommitUndo::NAME => call::<p::CommitUndo>(ctx, params, commit_actions::undo),
        p::ConflictsList::NAME => call::<p::ConflictsList>(ctx, params, conflicts::list),
        p::ConflictAccept::NAME => call::<p::ConflictAccept>(ctx, params, conflicts::accept),
        p::CompareCommits::NAME => call::<p::CompareCommits>(ctx, params, compare::commits),
        p::CompareFiles::NAME => call::<p::CompareFiles>(ctx, params, compare::files),
        other => Err(Error::new(format!("Failed to find method '{other}'."))),
    }
}

fn call<M: Method>(ctx: &Ctx, params: Value, handler: fn(&Ctx, M::Params) -> Result<M::Result>) -> Result<Value> {
    // Methods without params may be sent with `params` omitted.
    let params = if params.is_null() { Value::Object(Default::default()) } else { params };
    let params: M::Params = serde_json::from_value(params)
        .map_err(|e| Error::new(format!("Failed to parse params for '{}': {e}", M::NAME)))?;
    let result = handler(ctx, params)?;
    Ok(serde_json::to_value(result).expect("Failed to serialize a result"))
}

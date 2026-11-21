//! Messages between the GitSense app and `gitsense-helper`.
//!
//! The app writes one JSON [`Request`] per line to the helper's stdin. The
//! helper writes one JSON [`HelperMessage`] per line to its stdout: responses
//! to requests, matched by `id`, and unsolicited events.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

mod methods;
mod patches;
pub mod ts;

pub use methods::*;
pub use patches::*;

/// A protocol method: its wire name and its parameter and result types.
pub trait Method {
    const NAME: &'static str;
    type Params: Serialize + DeserializeOwned + TS + 'static;
    type Result: Serialize + DeserializeOwned + TS + 'static;
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Serialize, Deserialize, Debug, Clone, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HelperMessage {
    Response {
        id: u64,
        #[ts(type = "unknown")]
        result: Value,
    },
    Error {
        id: u64,
        message: String,
    },
    Event {
        event: Event,
    },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    /// First message from a started helper.
    Ready { helper_version: String, git_version: String, home: String },
    /// Something in the repo's working tree or git dir changed.
    RepoChanged { repo: String },
    /// A git command the helper ran, for the Git Console.
    GitCommand(GitCommandLog),
    /// Output from a long-running request, such as fetch or push.
    Progress { request_id: u64, text: String },
    /// Something the user should know about that is not tied to a request.
    Notice { text: String },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, TS)]
pub struct GitCommandLog {
    pub repo: String,
    pub args: Vec<String>,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    /// Combined stderr, plus stdout for commands that change the repo. Truncated.
    pub output: String,
}

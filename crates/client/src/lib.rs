//! Starts `gitsense-helper` on a machine and talks to it.
//!
//! [`connect`] runs a shell on the machine through a [`Transport`], installs
//! the helper there if needed, starts it, and returns a [`Connection`] for
//! protocol calls plus a channel of [`ClientEvent`]s. Both transports share
//! everything after starting the shell.

mod bootstrap;

use std::borrow::Cow;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use gitsense_protocol::{Event, HelperMessage, Method, Request};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};

/// How long starting the shell and the helper may take, including upload.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(120);
/// Lines of shell stderr kept for error messages.
const STDERR_TAIL_LINES: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transport {
    /// This computer.
    Local,
    /// A host as understood by the system `ssh`, including `~/.ssh/config` aliases.
    Ssh { host: String },
}

impl Transport {
    pub fn label(&self) -> &str {
        match self {
            Transport::Local => "this computer",
            Transport::Ssh { host } => host,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ConnectOptions {
    /// Environment variables exported in the machine's shell before the
    /// helper starts, such as `GITSENSE_HOME` for its cache and state dirs.
    pub env: Vec<(String, String)>,
}

/// The helper executable to install on machines.
pub struct HelperBinary {
    bytes: Cow<'static, [u8]>,
    hash: OnceLock<String>,
}

impl HelperBinary {
    pub fn new(bytes: impl Into<Cow<'static, [u8]>>) -> Self {
        Self { bytes: bytes.into(), hash: OnceLock::new() }
    }

    /// Lowercase hex SHA-256 of the executable.
    pub fn hash(&self) -> &str {
        self.hash.get_or_init(|| {
            use sha2::Digest;
            let digest = sha2::Sha256::digest(&self.bytes);
            digest.iter().map(|b| format!("{b:02x}")).collect()
        })
    }

    fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ClientEvent {
    Helper(Event),
    /// The connection ended. Every later call fails.
    Disconnected {
        reason: String,
    },
}

/// Facts the helper reported on start.
#[derive(Debug, Clone, PartialEq)]
pub struct HelperInfo {
    pub helper_version: String,
    pub git_version: String,
    pub home: String,
}

type Pending = Arc<Mutex<Option<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>>;

pub struct Connection {
    stdin: tokio::sync::Mutex<ChildStdin>,
    /// Waiting calls by id; None once disconnected.
    pending: Pending,
    next_id: AtomicU64,
    info: HelperInfo,
    stderr_tail: Arc<Mutex<Vec<String>>>,
    _child: Child,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

pub async fn connect(
    transport: &Transport,
    helper: &HelperBinary,
    options: &ConnectOptions,
) -> Result<(Connection, mpsc::UnboundedReceiver<ClientEvent>), Error> {
    let mut cmd = match transport {
        Transport::Local => {
            let mut cmd = Command::new("sh");
            cmd.arg("-s");
            if let Some(home) = std::env::var_os("HOME") {
                cmd.current_dir(home);
            }
            cmd
        }
        Transport::Ssh { host } => {
            let mut cmd = Command::new("ssh");
            cmd.args(["-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"])
                .args(["--", host, "sh", "-s"]);
            cmd
        }
    };
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let label = transport.label().to_string();
    let mut child = cmd.spawn().map_err(|e| Error(format!("Failed to start a shell on {label}: {e}")))?;

    let stderr_tail = Arc::new(Mutex::new(Vec::new()));
    let stderr = child.stderr.take().expect("stderr is piped");
    let tail = stderr_tail.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut tail = tail.lock().unwrap();
            if tail.len() == STDERR_TAIL_LINES {
                tail.remove(0);
            }
            tail.push(line);
        }
    });

    let mut stdin = child.stdin.take().expect("stdin is piped");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout is piped")).lines();
    let started = tokio::time::timeout(
        CONNECT_TIMEOUT,
        bootstrap::start_helper(&label, helper, options, &mut stdin, &mut stdout),
    )
    .await;
    let info = match started {
        Ok(Ok(info)) => info,
        Ok(Err(e)) => return Err(with_stderr(e, &stderr_tail)),
        Err(_) => {
            let e = Error(format!("Failed to connect to {label}: timed out after {}s.", CONNECT_TIMEOUT.as_secs()));
            return Err(with_stderr(e, &stderr_tail));
        }
    };

    let pending: Pending = Arc::new(Mutex::new(Some(HashMap::new())));
    let (events_tx, events_rx) = mpsc::unbounded_channel();
    let reader_pending = pending.clone();
    let reader_tail = stderr_tail.clone();
    tokio::spawn(async move {
        let reason = read_messages(&mut stdout, &reader_pending, &events_tx).await;
        // Give the stderr reader a moment to collect the shell's last words.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let reason = with_stderr(Error(reason), &reader_tail).0;
        let waiting = reader_pending.lock().unwrap().take().unwrap_or_default();
        for (_, reply) in waiting {
            let _ = reply.send(Err(reason.clone()));
        }
        let _ = events_tx.send(ClientEvent::Disconnected { reason });
    });

    let connection = Connection {
        stdin: tokio::sync::Mutex::new(stdin),
        pending,
        next_id: AtomicU64::new(1),
        info,
        stderr_tail,
        _child: child,
    };
    Ok((connection, events_rx))
}

/// Routes helper messages until stdout closes, then returns why.
async fn read_messages(
    stdout: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    pending: &Pending,
    events: &mpsc::UnboundedSender<ClientEvent>,
) -> String {
    loop {
        let line = match stdout.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => return "Disconnected: the helper exited.".to_string(),
            Err(e) => return format!("Disconnected: failed to read from the helper: {e}"),
        };
        let message: HelperMessage = match serde_json::from_str(&line) {
            Ok(message) => message,
            Err(e) => return format!("Disconnected: failed to parse helper message {line:?}: {e}"),
        };
        let (id, result) = match message {
            HelperMessage::Response { id, result } => (id, Ok(result)),
            HelperMessage::Error { id, message } => (id, Err(message)),
            HelperMessage::Event { event } => {
                let _ = events.send(ClientEvent::Helper(event));
                continue;
            }
        };
        let reply = pending.lock().unwrap().as_mut().and_then(|p| p.remove(&id));
        if let Some(reply) = reply {
            let _ = reply.send(result);
        }
    }
}

fn with_stderr(e: Error, tail: &Mutex<Vec<String>>) -> Error {
    let tail = tail.lock().unwrap();
    if tail.is_empty() { e } else { Error(format!("{}\n{}", e.0, tail.join("\n"))) }
}

impl Connection {
    pub fn info(&self) -> &HelperInfo {
        &self.info
    }

    pub async fn call<M: Method>(&self, params: M::Params) -> Result<M::Result, Error> {
        let params = serde_json::to_value(params).expect("Failed to serialize params");
        let result = self.call_raw(M::NAME, params).await?;
        serde_json::from_value(result).map_err(|e| Error(format!("Failed to parse the result of '{}': {e}", M::NAME)))
    }

    /// Calls a method by name with JSON params, for relaying requests from the UI.
    pub async fn call_raw(&self, method: &str, params: Value) -> Result<Value, Error> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (reply_tx, reply_rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            let Some(pending) = pending.as_mut() else {
                return Err(Error(format!("Failed to call '{method}': disconnected.")));
            };
            pending.insert(id, reply_tx);
        }
        let request = Request { id, method: method.to_string(), params };
        let mut line = serde_json::to_string(&request).expect("Failed to serialize a request");
        line.push('\n');
        let written = {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(line.as_bytes()).await.and(stdin.flush().await)
        };
        if let Err(e) = written {
            if let Some(pending) = self.pending.lock().unwrap().as_mut() {
                pending.remove(&id);
            }
            return Err(with_stderr(Error(format!("Failed to send '{method}': {e}")), &self.stderr_tail));
        }
        match reply_rx.await {
            Ok(result) => result.map_err(Error),
            Err(_) => Err(Error(format!("Failed to call '{method}': disconnected."))),
        }
    }
}

mod common;

use common::Machine;
use gitsense_client::{ClientEvent, HelperBinary, Transport, connect};
use gitsense_protocol::{Empty, ReposList};

fn cached_helpers(machine: &Machine) -> Vec<String> {
    let dir = machine.gitsense_home().join("cache");
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    names.sort();
    names
}

#[tokio::test]
async fn installs_the_helper_once_and_reuses_it() {
    let machine = Machine::new();
    let helper = common::helper();

    let session = machine.connect_local().await;
    assert_eq!(cached_helpers(&machine), [format!("helper-{}", helper.hash())]);
    assert_eq!(session.conn.info().home, machine.home().display().to_string());
    drop(session);

    let installed = machine.gitsense_home().join("cache").join(format!("helper-{}", helper.hash()));
    let inode = std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(&installed).unwrap());
    let session = machine.connect_local().await;
    session.conn.call::<ReposList>(Empty {}).await.unwrap();
    assert_eq!(std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(&installed).unwrap()), inode);
}

#[tokio::test]
async fn reports_a_helper_that_fails_to_start_with_its_stderr() {
    let machine = Machine::new();
    let broken = HelperBinary::new(b"not a program".to_vec());
    let error = match connect(&Transport::Local, &broken, &machine.options()).await {
        Ok(_) => panic!("Connected with a broken helper"),
        Err(e) => e,
    };
    assert!(error.0.starts_with("Failed to connect to this computer"), "{error}");
    assert!(error.0.contains(&format!("helper-{}", broken.hash())), "{error}");
}

#[tokio::test]
async fn ends_with_a_disconnect_event_when_the_helper_exits() {
    let machine = Machine::new();
    let mut session = machine.connect_local().await;
    let helper_pid = std::process::Command::new("pgrep")
        .args(["-f", &machine.gitsense_home().join("cache").display().to_string()])
        .output()
        .unwrap();
    let pid = String::from_utf8(helper_pid.stdout).unwrap();
    let pid = pid.lines().next().expect("Failed to find the helper process");
    std::process::Command::new("kill").arg(pid).status().unwrap();
    loop {
        match session.events.recv().await.expect("The event channel closed without a disconnect") {
            ClientEvent::Disconnected { .. } => break,
            ClientEvent::Helper(_) => {}
        }
    }
    assert!(session.conn.call::<ReposList>(Empty {}).await.is_err());
}

/// Runs over `ssh localhost` when key-based login to it works, as the design asks.
#[tokio::test]
async fn connects_over_ssh_localhost() {
    let reachable = std::process::Command::new("ssh")
        .args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "localhost", "true"])
        .status()
        .is_ok_and(|s| s.success());
    if !reachable {
        eprintln!("Skipping: 'ssh localhost' is not available.");
        return;
    }
    let machine = Machine::new();
    let session = machine.connect(&Transport::Ssh { host: "localhost".into() }).await;
    assert_eq!(session.conn.info().home, machine.home().display().to_string());
}

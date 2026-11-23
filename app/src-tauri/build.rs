//! Builds the static helper and embeds it in the app.

use std::path::PathBuf;
use std::process::Command;

const HELPER_TARGET: &str = "x86_64-unknown-linux-musl";

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let workspace = manifest_dir.join("../..").canonicalize().unwrap();
    for dir in ["crates/helper/src", "crates/protocol/src", "crates/helper/Cargo.toml", "crates/protocol/Cargo.toml"] {
        println!("cargo:rerun-if-changed={}", workspace.join(dir).display());
    }
    println!("cargo:rerun-if-env-changed=GITSENSE_HELPER_PATH");

    let helper = match std::env::var_os("GITSENSE_HELPER_PATH") {
        Some(path) => PathBuf::from(path),
        None => build_helper(&workspace),
    };
    assert!(helper.is_file(), "Failed to find the helper at '{}'.", helper.display());
    println!("cargo:rustc-env=GITSENSE_HELPER_PATH={}", helper.display());

    tauri_build::build();
}

/// Builds the helper with its own target dir, so this nested cargo doesn't
/// wait on the outer build's lock. The helper uses the app's profile, release
/// or dev.
fn build_helper(workspace: &std::path::Path) -> PathBuf {
    let target_dir = workspace.join("target/helper");
    let profile = std::env::var("PROFILE").unwrap();
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let mut command = Command::new(cargo);
    command.args(["build", "-p", "gitsense-helper", "--target", HELPER_TARGET, "--target-dir"]).arg(&target_dir);
    if profile == "release" {
        command.arg("--release");
    }
    let status = command
        .current_dir(workspace)
        .env_remove("RUSTFLAGS")
        .env_remove("CARGO_ENCODED_RUSTFLAGS")
        .status()
        .expect("Failed to run cargo to build the helper");
    assert!(
        status.success(),
        "Failed to build the helper for {HELPER_TARGET}; is the target installed (rustup target add {HELPER_TARGET})?"
    );
    target_dir.join(HELPER_TARGET).join(&profile).join("gitsense-helper")
}

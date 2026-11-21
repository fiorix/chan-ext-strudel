//! Window-scoped Chan operations through the installed `cs` client.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use tokio::process::Command;

pub(crate) struct Cs {
    binary: PathBuf,
}

pub(crate) struct CsOutput {
    pub(crate) code: i32,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

impl CsOutput {
    pub(crate) fn ok(&self) -> bool {
        self.code == 0
    }

    pub(crate) fn message(&self) -> String {
        let stderr = self.stderr.trim();
        if !stderr.is_empty() {
            return stderr.to_string();
        }
        self.stdout.trim().to_string()
    }
}

impl Cs {
    pub(crate) fn locate() -> Result<Self> {
        let binary = locate_binary().context(
            "cannot find the `cs` binary; put it on PATH or set $STRUDEL_CS to its path",
        )?;
        Ok(Self { binary })
    }

    #[cfg(test)]
    pub(crate) fn for_test(binary: PathBuf) -> Self {
        Self { binary }
    }

    pub(crate) async fn open(&self, window_id: &str, path: &Path) -> Result<()> {
        let socket = self.socket_for(window_id).await?;
        let output = self
            .run_on(&socket, window_id, [OsStr::new("open"), path.as_os_str()])
            .await?;
        if !output.ok() {
            bail!("{}", output.message());
        }
        Ok(())
    }

    async fn run_on<I, S>(&self, socket: &Path, window_id: &str, args: I) -> Result<CsOutput>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut command = Command::new(&self.binary);
        command
            .args(args)
            .env("CHAN_CONTROL_SOCKET", socket)
            .env("CHAN_WINDOW_ID", window_id)
            .env_remove("CHAN_WORKSPACE_PATH")
            .env_remove("CHAN_TAB_NAME")
            .env_remove("CHAN_TAB_GROUP")
            .kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(15), command.output())
            .await
            .context("cs did not acknowledge the operation within 15 seconds")?
            .with_context(|| format!("running {}", self.binary.display()))?;
        Ok(CsOutput {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }

    async fn socket_for(&self, window_id: &str) -> Result<PathBuf> {
        for candidate in socket_candidates() {
            let probe = self
                .run_on(&candidate, window_id, ["pane", "list", "--json"])
                .await?;
            if probe.ok() {
                return Ok(candidate);
            }
        }
        bail!("no chan control socket serves window {window_id}; is this window still connected?")
    }
}

fn locate_binary() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("STRUDEL_CS")
        && !explicit.trim().is_empty()
    {
        let path = PathBuf::from(explicit.trim());
        if path.is_file() {
            return Some(path);
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(cs_file_name());
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let sibling = std::env::current_exe().ok()?.parent()?.join(cs_file_name());
    sibling.is_file().then_some(sibling)
}

fn cs_file_name() -> &'static str {
    if cfg!(windows) { "cs.exe" } else { "cs" }
}

fn socket_candidates() -> Vec<PathBuf> {
    let parent = parent_pid();
    let mut pid_named = Vec::new();
    let mut stable = Vec::new();
    let mut rest = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    for dir in socket_dirs() {
        if seen.contains(&dir) {
            continue;
        }
        seen.push(dir.clone());
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let Some(rank) = socket_rank(name, parent) else {
                continue;
            };
            let path = entry.path();
            match rank {
                Rank::ParentPid => pid_named.push(path),
                Rank::Stable => stable.push(path),
                Rank::Other => rest.push(path),
            }
        }
    }
    pid_named.sort();
    stable.sort();
    rest.sort();
    pid_named.extend(stable);
    pid_named.extend(rest);
    pid_named
}

#[derive(Clone, Copy)]
enum Rank {
    ParentPid,
    Stable,
    Other,
}

fn socket_tail(name: &str) -> Option<&str> {
    let tail = name.strip_prefix("chan-control-")?;
    let tail = match tail.strip_suffix(".sock") {
        Some(stripped) => stripped,
        None if cfg!(windows) => tail,
        None => return None,
    };
    (!tail.is_empty() && !tail.contains('.')).then_some(tail)
}

fn socket_rank(name: &str, parent: Option<u32>) -> Option<Rank> {
    let tail = socket_tail(name)?;
    Some(match parent {
        Some(pid) if tail.starts_with(&format!("{pid}-")) => Rank::ParentPid,
        _ if tail.starts_with('s') => Rank::Stable,
        _ => Rank::Other,
    })
}

fn socket_dirs() -> Vec<PathBuf> {
    if cfg!(windows) {
        return vec![PathBuf::from(r"\\.\pipe\")];
    }
    let mut dirs = Vec::new();
    if let Ok(runtime) = std::env::var("XDG_RUNTIME_DIR")
        && !runtime.trim().is_empty()
    {
        dirs.push(PathBuf::from(runtime));
    }
    dirs.push(std::env::temp_dir());
    dirs.push(PathBuf::from("/tmp"));
    dirs
}

#[cfg(unix)]
fn parent_pid() -> Option<u32> {
    Some(std::os::unix::process::parent_id())
}

#[cfg(not(unix))]
fn parent_pid() -> Option<u32> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_prefer_the_parent_and_stable_sockets() {
        let parent = Some(4242);
        assert!(matches!(
            socket_rank("chan-control-4242-deadbeef.sock", parent),
            Some(Rank::ParentPid)
        ));
        assert!(matches!(
            socket_rank("chan-control-s0123456789abcdef.sock", parent),
            Some(Rank::Stable)
        ));
        assert!(matches!(
            socket_rank("chan-control-99999999-cafe.sock", parent),
            Some(Rank::Other)
        ));
        for unrelated in ["not-a-chan-socket", "chan-control-broken.txt", "sshd.pipe"] {
            assert!(socket_rank(unrelated, parent).is_none());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cs_open_uses_the_selected_window_and_socket() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("cs");
        let script_body = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$CHAN_WINDOW_ID\" > '{0}/window'\nprintf '%s\\n' \"$CHAN_CONTROL_SOCKET\" > '{0}/socket'\nprintf '%s\\n' \"$@\" > '{0}/args'\n",
            dir.path().display()
        );
        std::fs::write(&script, script_body).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cs = Cs::for_test(script);
        let target = dir.path().join("recordings");
        cs.run_on(
            Path::new("/tmp/strudel-test.sock"),
            "window-a",
            [OsStr::new("open"), target.as_os_str()],
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("window")).unwrap(),
            "window-a\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("socket")).unwrap(),
            "/tmp/strudel-test.sock\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("args")).unwrap(),
            format!("open\n{}\n", target.display())
        );
    }

    #[test]
    fn stderr_is_the_actionable_failure() {
        let output = CsOutput {
            code: 1,
            stdout: "ignored".into(),
            stderr: "window is offline\n".into(),
        };
        assert!(!output.ok());
        assert_eq!(output.message(), "window is offline");
    }
}

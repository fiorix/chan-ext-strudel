//! Private, atomic per-session records and export files. The server is the
//! only writer.

use std::fs;
#[cfg(unix)]
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Serialize, de::DeserializeOwned};

use crate::valid_id;

const MAX_RECORD_BYTES: u64 = 1024 * 1024;

#[derive(Clone)]
pub(crate) struct Store {
    root: PathBuf,
}

impl Store {
    pub(crate) fn new(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&root).with_context(|| format!("creating {}", root.display()))?;
        if fs::symlink_metadata(&root)?.file_type().is_symlink() {
            bail!("Storage directory cannot be a symlink.");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self { root })
    }

    /// A per-session directory, named by the opaque owner key.
    pub(crate) fn owner(&self, owner: &str) -> Result<Self> {
        self.subdir(owner)
    }

    pub(crate) fn subdir(&self, name: &str) -> Result<Self> {
        check_id(name)?;
        Self::new(self.root.join(name))
    }

    pub(crate) fn load<T: DeserializeOwned>(&self, name: &str) -> Result<Option<T>> {
        let path = self.root.join(name);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            _ => read_json(&path).map(Some),
        }
    }

    pub(crate) fn save(&self, name: &str, value: &impl Serialize) -> Result<()> {
        atomic_json(&self.root.join(name), value)
    }

    /// Write `bytes` under a name derived from `stem` and `extension` that no
    /// existing file carries, and return the path written.
    pub(crate) fn write_unique(
        &self,
        stem: &str,
        extension: &str,
        bytes: &[u8],
    ) -> Result<PathBuf> {
        for attempt in 1..=1000u32 {
            let name = if attempt == 1 {
                format!("{stem}.{extension}")
            } else {
                format!("{stem}-{attempt}.{extension}")
            };
            let path = self.root.join(name);
            if fs::symlink_metadata(&path).is_ok() {
                continue;
            }
            atomic_bytes(&path, bytes)?;
            return Ok(path);
        }
        bail!("Too many files named {stem}.{extension}.");
    }
}

fn check_id(id: &str) -> Result<()> {
    if !valid_id(id) {
        bail!("Invalid storage ID.");
    }
    Ok(())
}

pub(crate) fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("reading {}", path.display()))?;
    if !metadata.is_file() || metadata.len() > MAX_RECORD_BYTES {
        bail!(
            "Expected a regular file of at most 1 MiB: {}",
            path.display()
        );
    }
    serde_json::from_slice(&fs::read(path)?).with_context(|| format!("parsing {}", path.display()))
}

pub(crate) fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        bail!("Record exceeds the 1 MiB storage limit.");
    }
    atomic_bytes(path, &bytes)
}

pub(crate) fn atomic_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("record has no parent directory")?;
    if let Ok(metadata) = fs::symlink_metadata(path)
        && !metadata.is_file()
    {
        bail!(
            "Refusing to replace a non-regular record: {}",
            path.display()
        );
    }
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(path)
        .with_context(|| format!("saving {}", path.display()))?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn records_replace_atomically_and_reject_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf()).unwrap();
        assert!(store.owner("../escape").is_err());
        let path = dir.path().join("test.json");
        atomic_json(&path, &json!({"value": 1})).unwrap();
        atomic_json(&path, &json!({"value": 2})).unwrap();
        assert_eq!(read_json::<serde_json::Value>(&path).unwrap()["value"], 2);
        fs::write(&path, "partial").unwrap();
        assert!(read_json::<serde_json::Value>(&path).is_err());
    }

    #[test]
    fn a_missing_record_loads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf()).unwrap();
        assert!(
            store
                .load::<serde_json::Value>("state.json")
                .unwrap()
                .is_none()
        );
        store.save("state.json", &json!({"version": 1})).unwrap();
        assert_eq!(
            store
                .load::<serde_json::Value>("state.json")
                .unwrap()
                .unwrap()["version"],
            1
        );
    }

    #[test]
    fn unique_writes_never_replace_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().to_path_buf()).unwrap();
        let first = store.write_unique("take", "wav", b"one").unwrap();
        let second = store.write_unique("take", "wav", b"two").unwrap();
        assert_eq!(first.file_name().unwrap(), "take.wav");
        assert_eq!(second.file_name().unwrap(), "take-2.wav");
        assert_eq!(fs::read(&first).unwrap(), b"one");
        assert_eq!(fs::read(&second).unwrap(), b"two");
    }

    #[cfg(unix)]
    #[test]
    fn records_are_private_and_symlinks_are_refused() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("record.json");
        atomic_json(&path, &json!({"private": true})).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let link = dir.path().join("link.json");
        symlink(&path, &link).unwrap();
        assert!(read_json::<serde_json::Value>(&link).is_err());
        assert!(atomic_json(&link, &json!({})).is_err());
    }
}

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import unittest
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = REPO_ROOT / "scripts/package-chan-extension.py"
SPEC = importlib.util.spec_from_file_location("package_chan_extension", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
PACKAGE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = PACKAGE
SPEC.loader.exec_module(PACKAGE)

# The release inputs the packager reads from the repository root. The test
# copies them into a scratch repository with one commit, so it does not depend
# on this checkout's history and runs before the first commit.
INPUTS = (
    "Cargo.toml",
    "LICENSE",
    "LICENSE-APACHE",
    "packaging/chan-extension/strudel.toml",
    "runtime/strudel.lock.json",
    "runtime/strudel-LICENSE",
)


class PackageChanExtensionTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(temporary)
        self.repo = self.root / "repo"
        for relative in INPUTS:
            source = REPO_ROOT / relative
            if not source.is_file():
                self.skipTest(f"{relative} is missing; run scripts/fetch-strudel.py")
            destination = self.repo / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        npm = REPO_ROOT / "runtime/npm"
        if not npm.is_dir():
            self.skipTest("runtime/npm is missing; run scripts/fetch-strudel.py")
        shutil.copytree(npm, self.repo / "runtime/npm")
        env = {
            **os.environ,
            "GIT_AUTHOR_NAME": "test",
            "GIT_AUTHOR_EMAIL": "test@example.invalid",
            "GIT_COMMITTER_NAME": "test",
            "GIT_COMMITTER_EMAIL": "test@example.invalid",
            "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z",
            "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z",
        }
        for command in (
            ["git", "init", "-q", "-b", "main"],
            ["git", "add", "-A"],
            ["git", "commit", "-q", "-m", "release inputs"],
        ):
            subprocess.run(command, cwd=self.repo, env=env, check=True)

    def build(self, target: str) -> Path:
        binary = self.root / PACKAGE.TARGETS[target].executable
        binary.write_bytes(b"test binary")
        return PACKAGE.build_package(self.repo, target, binary, self.root / "dist")

    def expected_source_files(self) -> list[str]:
        lock = PACKAGE.FETCH.load_lock(self.repo / "runtime/strudel.lock.json")
        version = PACKAGE.workspace_version(self.repo)
        return [f"source/{PACKAGE.PAYLOAD_ROOT}-{version}.tar.gz"] + [
            f"source/npm/{name}" for name in PACKAGE.source_tarballs(lock)
        ]

    def test_unix_archive_carries_everything_the_installer_requires(self) -> None:
        archive = self.build("linux-x86_64")
        with tarfile.open(archive, "r:gz") as bundle:
            names = set(bundle.getnames())
            executable = bundle.getmember("chan-ext-strudel/strudel-extension")
            self.assertEqual(executable.mode, 0o755, "the binary must stay executable")
            sources = bundle.extractfile("chan-ext-strudel/source/SOURCES.md")
            assert sources is not None
            text = sources.read().decode()
        for required in PACKAGE.PAYLOAD_FILES + tuple(self.expected_source_files()):
            self.assertIn(f"chan-ext-strudel/{required}", names)
        self.assertIn("@strudel/repl", text)
        self.assertIn("codeberg.org/uzu/strudel", text)

    def test_windows_archive_uses_the_exe_name(self) -> None:
        archive = self.build("windows-x86_64")
        with zipfile.ZipFile(archive) as bundle:
            names = set(bundle.namelist())
        self.assertIn("chan-ext-strudel/strudel-extension.exe", names)
        for required in PACKAGE.PAYLOAD_FILES + tuple(self.expected_source_files()):
            self.assertIn(f"chan-ext-strudel/{required}", names)

    def test_every_target_is_named_for_its_platform(self) -> None:
        # install.sh selects an archive by these exact names.
        self.assertEqual(
            {name: target.archive for name, target in PACKAGE.TARGETS.items()},
            {
                "linux-x86_64": "chan-ext-strudel-linux-x86_64.tar.gz",
                "linux-aarch64": "chan-ext-strudel-linux-aarch64.tar.gz",
                "windows-x86_64": "chan-ext-strudel-windows-x86_64.zip",
                "macos-aarch64": "chan-ext-strudel-macos-aarch64.tar.gz",
            },
        )

    def test_the_declaration_in_the_archive_matches_what_chan_accepts(self) -> None:
        # A field Chan does not know silently drops the whole extension, so the
        # shipped template has to stay within its four fields.
        declaration = (REPO_ROOT / "packaging/chan-extension/strudel.toml").read_bytes()
        parsed = tomllib.loads(declaration.decode())
        self.assertEqual(set(parsed), {"name", "command", "args", "capabilities"})
        self.assertEqual(parsed["name"], "Strudel")
        self.assertEqual(parsed["capabilities"], ["presentation"])

    def test_a_stale_source_tarball_is_refused(self) -> None:
        lock = PACKAGE.FETCH.load_lock(self.repo / "runtime/strudel.lock.json")
        name = PACKAGE.source_tarballs(lock)[0]
        (self.repo / "runtime/npm" / name).write_bytes(b"stale")
        with self.assertRaises(SystemExit) as refused:
            self.build("linux-x86_64")
        self.assertIn("fetch-strudel", str(refused.exception))

    def test_archive_is_reproducible(self) -> None:
        first = self.build("linux-x86_64").read_bytes()
        second = self.build("linux-x86_64").read_bytes()
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()

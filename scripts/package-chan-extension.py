#!/usr/bin/env python3
"""Assemble a self-contained Chan extension release archive.

Besides the binary and its declaration template, every archive carries the
licenses and the corresponding source for what the binary embeds: the pinned
Strudel npm tarballs and an archive of this repository at HEAD.
"""

from __future__ import annotations

import argparse
import gzip
import importlib.util
import json
import logging
import os
import shutil
import stat
import subprocess
import tarfile
import tempfile
import tomllib
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

LOG = logging.getLogger("chan-ext-strudel-package")
PAYLOAD_ROOT = "chan-ext-strudel"


def load_fetch_module():
    path = Path(__file__).resolve().with_name("fetch-strudel.py")
    spec = importlib.util.spec_from_file_location("fetch_strudel", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


FETCH = load_fetch_module()


@dataclass(frozen=True)
class Target:
    archive: str
    executable: str
    zip: bool = False


TARGETS = {
    "linux-x86_64": Target("chan-ext-strudel-linux-x86_64.tar.gz", "strudel-extension"),
    "linux-aarch64": Target("chan-ext-strudel-linux-aarch64.tar.gz", "strudel-extension"),
    "windows-x86_64": Target(
        "chan-ext-strudel-windows-x86_64.zip", "strudel-extension.exe", zip=True
    ),
    "macos-aarch64": Target("chan-ext-strudel-macos-aarch64.tar.gz", "strudel-extension"),
}

# Everything the installer expects to find by name, relative to the payload
# root. The source tarballs are named by the lock and checked separately.
PAYLOAD_FILES = (
    "strudel.toml",
    "licenses/LICENSE-AGPL-3.0",
    "licenses/LICENSE-APACHE",
    "licenses/strudel-LICENSE",
    "source/SOURCES.md",
)


def workspace_version(repo_root: Path) -> str:
    with (repo_root / "Cargo.toml").open("rb") as cargo_toml:
        document = tomllib.load(cargo_toml)
    return str(document["workspace"]["package"]["version"])


def source_date_epoch(repo_root: Path) -> int:
    """A fixed timestamp for every archive entry, so builds are reproducible.

    The commit time is the source of truth: falling back to the current time
    would make the same commit produce a different archive on every run.
    """
    configured = os.environ.get("SOURCE_DATE_EPOCH")
    if configured is not None:
        return int(configured)
    result = subprocess.run(
        ["git", "show", "-s", "--format=%ct", "HEAD"],
        cwd=repo_root,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        raise SystemExit(
            "package-chan-extension: cannot read the HEAD commit time, which "
            "stamps every archive entry. Commit first, or set SOURCE_DATE_EPOCH."
        )
    return int(result.stdout.strip())


def copy_file(source: Path, destination: Path, mode: int = 0o644) -> None:
    if not source.is_file():
        raise FileNotFoundError(f"required release input is missing: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    destination.chmod(mode)


def source_tarballs(lock: dict) -> list[str]:
    """The npm tarball file names the lock pins, in lock order."""
    return [
        FETCH.tarball_filename(package["name"], package["version"])
        for package in lock["source"]["packages"]
    ]


def sources_markdown(lock: dict, version: str) -> str:
    source = lock["source"]
    lines = [
        "# Corresponding source",
        "",
        f"This archive ships chan-ext-strudel {version} under the GNU Affero General Public License, version 3 or later. The sources for everything it embeds are in this directory.",
        "",
        f"`{PAYLOAD_ROOT}-{version}.tar.gz` is this repository at the released commit.",
        "",
        f"`npm/` holds the Strudel packages bundled into the embedded REPL, as published on npm. They are built from the Strudel monorepo at `{source['repository']}` tag `{source['tag']}`, commit `{source['commit']}`.",
        "",
        "| package | version | tarball | integrity |",
        "| --- | --- | --- | --- |",
    ]
    for package in source["packages"]:
        lines.append(
            f"| `{package['name']}` | {package['version']} | `npm/{FETCH.tarball_filename(package['name'], package['version'])}` | `{package['integrity']}` |"
        )
    lines.append("")
    return "\n".join(lines)


def build_layout(
    repo_root: Path,
    binary: Path,
    target: Target,
    stage: Path,
    version: str,
    epoch: int,
) -> Path:
    payload = stage / PAYLOAD_ROOT
    copy_file(binary, payload / target.executable, 0o755)
    copy_file(
        repo_root / "packaging/chan-extension/strudel.toml",
        payload / "strudel.toml",
    )
    copy_file(repo_root / "LICENSE", payload / "licenses/LICENSE-AGPL-3.0")
    copy_file(repo_root / "LICENSE-APACHE", payload / "licenses/LICENSE-APACHE")
    copy_file(repo_root / "runtime/strudel-LICENSE", payload / "licenses/strudel-LICENSE")

    lock = FETCH.load_lock(repo_root / "runtime/strudel.lock.json")
    for package in lock["source"]["packages"]:
        name = FETCH.tarball_filename(package["name"], package["version"])
        tarball = repo_root / "runtime/npm" / name
        if not FETCH.matches_integrity(tarball, package["integrity"]):
            raise SystemExit(
                f"package-chan-extension: {tarball} is missing or does not match the "
                "lock. Run python3 scripts/fetch-strudel.py first."
            )
        copy_file(tarball, payload / "source/npm" / name)
    sources = payload / "source/SOURCES.md"
    sources.write_text(sources_markdown(lock, version))
    sources.chmod(0o644)

    source_archive = payload / f"source/{PAYLOAD_ROOT}-{version}.tar.gz"
    source_tar = stage / f"{PAYLOAD_ROOT}-{version}.tar"
    subprocess.run(
        [
            "git",
            "archive",
            "--format=tar",
            f"--mtime=@{epoch}",
            f"--prefix={PAYLOAD_ROOT}-{version}/",
            f"--output={source_tar}",
            "HEAD",
        ],
        cwd=repo_root,
        check=True,
    )
    with source_tar.open("rb") as source, source_archive.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=epoch) as zipped:
            shutil.copyfileobj(source, zipped)
    source_tar.unlink()
    source_archive.chmod(0o644)
    return payload


def normalized_tar_info(epoch: int):
    def normalize(info: tarfile.TarInfo) -> tarfile.TarInfo:
        info.uid = 0
        info.gid = 0
        info.uname = "root"
        info.gname = "root"
        info.mtime = epoch
        return info

    return normalize


def write_tar(payload: Path, output: Path, epoch: int) -> None:
    with output.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=epoch) as zipped:
            with tarfile.open(
                fileobj=zipped, mode="w", format=tarfile.PAX_FORMAT
            ) as archive:
                archive.add(
                    payload,
                    arcname=PAYLOAD_ROOT,
                    recursive=True,
                    filter=normalized_tar_info(epoch),
                )


def write_zip(payload: Path, output: Path, epoch: int) -> None:
    # The zip format cannot represent a timestamp before 1980.
    minimum_zip_epoch = 315_532_800
    timestamp = datetime.fromtimestamp(
        max(epoch, minimum_zip_epoch), tz=timezone.utc
    ).timetuple()[:6]
    with zipfile.ZipFile(
        output, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
    ) as archive:
        for path in sorted(item for item in payload.rglob("*") if item.is_file()):
            relative = path.relative_to(payload.parent).as_posix()
            info = zipfile.ZipInfo(relative, date_time=timestamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            mode = stat.S_IFREG | stat.S_IMODE(path.stat().st_mode)
            info.external_attr = mode << 16
            archive.writestr(info, path.read_bytes())


def build_package(
    repo_root: Path, target_name: str, binary: Path, output_dir: Path
) -> Path:
    target = TARGETS[target_name]
    version = workspace_version(repo_root)
    epoch = source_date_epoch(repo_root)
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / target.archive
    LOG.info("packaging %s from %s", target_name, binary)
    # Write to a sibling temporary file and rename, so a partial archive is
    # never visible at the output path.
    descriptor, pending_name = tempfile.mkstemp(
        prefix=f".{target.archive}.", dir=output_dir
    )
    os.close(descriptor)
    pending = Path(pending_name)
    try:
        with tempfile.TemporaryDirectory(prefix="chan-ext-strudel-package-") as temporary:
            payload = build_layout(
                repo_root, binary, target, Path(temporary), version, epoch
            )
            if target.zip:
                write_zip(payload, pending, epoch)
            else:
                write_tar(payload, pending, epoch)
        pending.replace(output)
    finally:
        pending.unlink(missing_ok=True)
    LOG.info("wrote %s", output)
    return output


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, choices=sorted(TARGETS))
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("-v", "--verbose", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="chan-ext-strudel-package: %(message)s",
    )
    repo_root = Path(__file__).resolve().parent.parent
    output = build_package(
        repo_root, args.target, args.binary.resolve(), args.output_dir
    )
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

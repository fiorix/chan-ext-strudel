#!/usr/bin/env python3
"""Download and verify the pinned Strudel packages into runtime/.

The lock names every npm tarball this extension embeds or ships as
corresponding source, with the registry's own integrity digest, and every file
the binary embeds out of those tarballs, with its byte count and sha256. Nothing
is extracted before its tarball verifies, and a run whose inputs already match
the lock touches no network.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import logging
import os
import re
import shutil
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

LOG = logging.getLogger("fetch-strudel")
REGISTRY = "https://registry.npmjs.org"
RETRY_DELAY_SECONDS = 5
RUNTIME_FILE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")


def tarball_filename(name: str, version: str) -> str:
    """`@strudel/repl` 1.3.0 becomes `strudel-repl-1.3.0.tgz`."""
    return f"{name.lstrip('@').replace('/', '-')}-{version}.tgz"


def decode_integrity(integrity: str) -> tuple[str, bytes]:
    """Split an npm `sha512-<base64>` integrity value into algorithm and digest."""
    algorithm, _, encoded = integrity.partition("-")
    if algorithm not in ("sha512", "sha256") or not encoded:
        raise ValueError(f"unsupported integrity value: {integrity!r}")
    return algorithm, base64.b64decode(encoded, validate=True)


def digest_file(path: Path, algorithm: str) -> bytes:
    digest = hashlib.new(algorithm)
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.digest()


def matches_integrity(path: Path, integrity: str) -> bool:
    if not path.is_file():
        return False
    algorithm, expected = decode_integrity(integrity)
    return digest_file(path, algorithm) == expected


def matches_pin(path: Path, pin: dict) -> bool:
    if not path.is_file() or path.stat().st_size != pin["bytes"]:
        return False
    return digest_file(path, "sha256").hex() == pin["sha256"]


def load_lock(path: Path) -> dict:
    lock = json.loads(path.read_text())
    if lock.get("version") != 2:
        raise SystemExit(f"fetch-strudel: unsupported lock version in {path}")
    names = {package["name"] for package in lock["source"]["packages"]}
    if lock["repl"] not in names:
        raise SystemExit("fetch-strudel: the repl package is not in the source list")
    for name, pin in lock["files"].items():
        if not RUNTIME_FILE_NAME.match(name):
            raise SystemExit(f"fetch-strudel: invalid runtime file name {name!r}")
        if pin["package"] not in names:
            raise SystemExit(f"fetch-strudel: {name} comes from {pin['package']}, which is not in the source list")
    return lock


def tarball_path(package: dict, runtime_dir: Path) -> Path:
    return runtime_dir / "npm" / tarball_filename(package["name"], package["version"])


def download(url: str, destination: Path) -> None:
    for attempt in (1, 2):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                with destination.open("wb") as handle:
                    shutil.copyfileobj(response, handle)
            return
        except (urllib.error.URLError, OSError) as error:
            if attempt == 2:
                raise SystemExit(f"fetch-strudel: downloading {url}: {error}") from error
            LOG.warning("retrying %s after: %s", url, error)
            time.sleep(RETRY_DELAY_SECONDS)


def ensure_tarball(package: dict, runtime_dir: Path) -> Path:
    """Return the verified tarball path, downloading it when absent or stale."""
    destination = tarball_path(package, runtime_dir)
    if matches_integrity(destination, package["integrity"]):
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    # The temporary directory sits next to the destination, so the final rename
    # never crosses a filesystem boundary.
    with tempfile.TemporaryDirectory(prefix=".fetch-strudel-", dir=destination.parent) as temporary:
        pending = Path(temporary) / destination.name
        LOG.info("downloading %s", package["tarball"])
        download(package["tarball"], pending)
        algorithm, expected = decode_integrity(package["integrity"])
        actual = digest_file(pending, algorithm)
        if actual != expected:
            raise SystemExit(
                f"fetch-strudel: {destination.name} {algorithm} is {actual.hex()}, "
                f"expected {expected.hex()}"
            )
        os.replace(pending, destination)
    return destination


def read_member(archive: tarfile.TarFile, name: str, tarball: Path, expected_size: int | None = None) -> bytes:
    try:
        member = archive.getmember(name)
    except KeyError as error:
        raise SystemExit(f"fetch-strudel: {tarball.name} has no member {name}") from error
    if not member.isfile():
        raise SystemExit(f"fetch-strudel: {name} in {tarball.name} is not a regular file")
    if expected_size is not None and member.size != expected_size:
        raise SystemExit(
            f"fetch-strudel: {name} in {tarball.name} is {member.size} bytes, expected {expected_size}"
        )
    source = archive.extractfile(member)
    if source is None:
        raise SystemExit(f"fetch-strudel: cannot read {name} in {tarball.name}")
    with source:
        return source.read()


def extract_pinned_files(lock: dict, tarballs: dict[str, Path], runtime_dir: Path, names: list[str]) -> None:
    """Write the named lock files out of their verified tarballs."""
    by_package: dict[str, list[str]] = {}
    for name in names:
        by_package.setdefault(lock["files"][name]["package"], []).append(name)
    for package, file_names in by_package.items():
        tarball = tarballs[package]
        with tarfile.open(tarball, "r:gz") as archive:
            for name in file_names:
                pin = lock["files"][name]
                data = read_member(archive, pin["from"], tarball, pin["bytes"])
                actual = hashlib.sha256(data).hexdigest()
                if actual != pin["sha256"]:
                    raise SystemExit(
                        f"fetch-strudel: {pin['from']} in {tarball.name} sha256 is {actual}, "
                        f"expected {pin['sha256']}"
                    )
                target = runtime_dir / name
                pending = target.with_name(f"{target.name}.tmp")
                pending.write_bytes(data)
                os.replace(pending, target)
                LOG.info("wrote %s", target)


def prune_tarballs(lock: dict, runtime_dir: Path) -> None:
    """Remove tarballs the lock no longer names, so a bump cannot ship stale source."""
    expected = {tarball_path(package, runtime_dir).name for package in lock["source"]["packages"]}
    npm_dir = runtime_dir / "npm"
    if not npm_dir.is_dir():
        return
    for path in npm_dir.glob("*.tgz"):
        if path.name not in expected:
            path.unlink()
            LOG.info("removed %s", path)


def stale_files(lock: dict, runtime_dir: Path) -> list[str]:
    return [name for name, pin in lock["files"].items() if not matches_pin(runtime_dir / name, pin)]


def runtime_is_current(lock: dict, runtime_dir: Path) -> bool:
    if stale_files(lock, runtime_dir):
        return False
    return all(
        matches_integrity(tarball_path(package, runtime_dir), package["integrity"])
        for package in lock["source"]["packages"]
    )


def sync(lock: dict, runtime_dir: Path) -> bool:
    """Bring runtime/ in line with the lock. Returns whether anything changed."""
    if runtime_is_current(lock, runtime_dir):
        return False
    runtime_dir.mkdir(parents=True, exist_ok=True)
    tarballs = {
        package["name"]: ensure_tarball(package, runtime_dir)
        for package in lock["source"]["packages"]
    }
    extract_pinned_files(lock, tarballs, runtime_dir, stale_files(lock, runtime_dir))
    prune_tarballs(lock, runtime_dir)
    return True


def registry_metadata(name: str, version: str) -> dict:
    url = f"{REGISTRY}/{urllib.parse.quote(name, safe='@')}/{version}"
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.load(response)


def pin(lock: dict, lock_path: Path, runtime_dir: Path) -> None:
    """Refresh tarball URLs, integrity values, and file digests from the registry."""
    for package in lock["source"]["packages"]:
        metadata = registry_metadata(package["name"], package["version"])
        package["tarball"] = metadata["dist"]["tarball"]
        package["integrity"] = metadata["dist"]["integrity"]
        LOG.info("pinned %s@%s", package["name"], package["version"])
    runtime_dir.mkdir(parents=True, exist_ok=True)
    tarballs = {
        package["name"]: ensure_tarball(package, runtime_dir)
        for package in lock["source"]["packages"]
    }
    for name, file_pin in lock["files"].items():
        tarball = tarballs[file_pin["package"]]
        with tarfile.open(tarball, "r:gz") as archive:
            data = read_member(archive, file_pin["from"], tarball)
        file_pin["bytes"] = len(data)
        file_pin["sha256"] = hashlib.sha256(data).hexdigest()
        LOG.info("pinned %s from %s", name, tarball.name)
    pending = lock_path.with_name(f"{lock_path.name}.tmp")
    pending.write_text(json.dumps(lock, indent=2, sort_keys=True) + "\n")
    os.replace(pending, lock_path)
    extract_pinned_files(lock, tarballs, runtime_dir, list(lock["files"]))
    prune_tarballs(lock, runtime_dir)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    repo_root = Path(__file__).resolve().parent.parent
    parser.add_argument("--runtime-dir", type=Path, default=repo_root / "runtime")
    parser.add_argument("--lock", type=Path, help="defaults to <runtime-dir>/strudel.lock.json")
    parser.add_argument(
        "--pin",
        action="store_true",
        help="rewrite the lock from the npm registry for the versions it names",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="fetch-strudel: %(message)s",
    )
    runtime_dir = args.runtime_dir.resolve()
    lock_path = (args.lock or runtime_dir / "strudel.lock.json").resolve()
    lock = load_lock(lock_path)
    if args.pin:
        pin(lock, lock_path, runtime_dir)
        print(f"fetch-strudel: pinned {len(lock['source']['packages'])} packages in {lock_path}")
    elif sync(lock, runtime_dir):
        print(f"fetch-strudel: runtime updated in {runtime_dir}")
    else:
        print("fetch-strudel: runtime is current")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

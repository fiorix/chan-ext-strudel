from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import re
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = REPO_ROOT / "scripts/fetch-strudel.py"
SPEC = importlib.util.spec_from_file_location("fetch_strudel", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
FETCH = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = FETCH
SPEC.loader.exec_module(FETCH)

BUNDLE = b"window.strudel = {};\n"
LICENSE = b"GNU AFFERO GENERAL PUBLIC LICENSE\n"
REFERENCE = b"export const reference = { docs: [] };\n"


def integrity_of(data: bytes) -> str:
    return "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()


def npm_tarball(members: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def file_pin(package: str, source: str, data: bytes) -> dict:
    return {
        "package": package,
        "from": source,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


class FetchStrudelTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.release = self.root / "release"
        self.release.mkdir()
        self.runtime = self.root / "runtime"

    def lock_for(
        self,
        repl_tarball: bytes,
        reference_tarball: bytes,
        *,
        repl_integrity: str | None = None,
        files: dict | None = None,
    ) -> dict:
        (self.release / "strudel-repl-1.3.0.tgz").write_bytes(repl_tarball)
        (self.release / "strudel-reference-1.2.2.tgz").write_bytes(reference_tarball)
        return {
            "version": 2,
            "repl": "@strudel/repl",
            "files": files
            or {
                "strudel-repl.js": file_pin("@strudel/repl", "package/dist/index.js", BUNDLE),
                "strudel-LICENSE": file_pin("@strudel/repl", "package/LICENSE", LICENSE),
                "strudel-reference.mjs": file_pin(
                    "@strudel/reference", "package/dist/index.mjs", REFERENCE
                ),
            },
            "source": {
                "tag": "@strudel/repl@1.3.0",
                "commit": "f" * 40,
                "repository": "https://example.invalid/strudel",
                "packages": [
                    {
                        "name": "@strudel/repl",
                        "version": "1.3.0",
                        "tarball": (self.release / "strudel-repl-1.3.0.tgz").as_uri(),
                        "integrity": repl_integrity or integrity_of(repl_tarball),
                    },
                    {
                        "name": "@strudel/reference",
                        "version": "1.2.2",
                        "tarball": (self.release / "strudel-reference-1.2.2.tgz").as_uri(),
                        "integrity": integrity_of(reference_tarball),
                    },
                ],
            },
        }

    def good_tarballs(self) -> tuple[bytes, bytes]:
        return (
            npm_tarball({"package/dist/index.js": BUNDLE, "package/LICENSE": LICENSE}),
            npm_tarball({"package/dist/index.mjs": REFERENCE}),
        )

    def test_integrity_parsing_rejects_unknown_algorithms(self) -> None:
        algorithm, digest = FETCH.decode_integrity(integrity_of(b"x"))
        self.assertEqual(algorithm, "sha512")
        self.assertEqual(digest, hashlib.sha512(b"x").digest())
        with self.assertRaises(ValueError):
            FETCH.decode_integrity("md5-abc")
        with self.assertRaises(ValueError):
            FETCH.decode_integrity("sha512-")

    def test_tarball_names_flatten_the_scope(self) -> None:
        self.assertEqual(FETCH.tarball_filename("@strudel/repl", "1.3.0"), "strudel-repl-1.3.0.tgz")
        self.assertEqual(FETCH.tarball_filename("superdough", "1.3.0"), "superdough-1.3.0.tgz")

    def test_sync_extracts_every_pinned_file_then_becomes_a_no_op(self) -> None:
        lock = self.lock_for(*self.good_tarballs())
        self.assertTrue(FETCH.sync(lock, self.runtime))
        self.assertEqual((self.runtime / "strudel-repl.js").read_bytes(), BUNDLE)
        self.assertEqual((self.runtime / "strudel-LICENSE").read_bytes(), LICENSE)
        self.assertEqual((self.runtime / "strudel-reference.mjs").read_bytes(), REFERENCE)
        self.assertEqual(
            sorted(path.name for path in (self.runtime / "npm").iterdir()),
            ["strudel-reference-1.2.2.tgz", "strudel-repl-1.3.0.tgz"],
        )
        # A second run has nothing to fetch; the release directory may vanish.
        for path in self.release.iterdir():
            path.unlink()
        self.assertFalse(FETCH.sync(lock, self.runtime))

    def test_sync_refreshes_only_the_stale_file(self) -> None:
        lock = self.lock_for(*self.good_tarballs())
        FETCH.sync(lock, self.runtime)
        (self.runtime / "strudel-reference.mjs").write_bytes(b"edited\n")
        self.assertTrue(FETCH.sync(lock, self.runtime))
        self.assertEqual((self.runtime / "strudel-reference.mjs").read_bytes(), REFERENCE)

    def test_sync_refuses_a_tarball_that_fails_integrity(self) -> None:
        lock = self.lock_for(*self.good_tarballs(), repl_integrity=integrity_of(b"not this tarball"))
        with self.assertRaises(SystemExit) as refused:
            FETCH.sync(lock, self.runtime)
        self.assertIn("sha512", str(refused.exception))
        self.assertFalse((self.runtime / "strudel-repl.js").exists())
        self.assertFalse((self.runtime / "npm" / "strudel-repl-1.3.0.tgz").exists())

    def test_sync_refuses_a_member_that_fails_its_pin(self) -> None:
        repl = npm_tarball({"package/dist/index.js": b"tampered\n", "package/LICENSE": LICENSE})
        lock = self.lock_for(repl, self.good_tarballs()[1])
        with self.assertRaises(SystemExit):
            FETCH.sync(lock, self.runtime)
        self.assertFalse((self.runtime / "strudel-repl.js").exists())

    def test_sync_prunes_tarballs_the_lock_no_longer_names(self) -> None:
        lock = self.lock_for(*self.good_tarballs())
        stale = self.runtime / "npm" / "strudel-repl-1.2.0.tgz"
        stale.parent.mkdir(parents=True)
        stale.write_bytes(b"old")
        FETCH.sync(lock, self.runtime)
        self.assertFalse(stale.exists())

    def test_the_repository_lock_is_complete(self) -> None:
        lock = FETCH.load_lock(REPO_ROOT / "runtime/strudel.lock.json")
        packages = {package["name"]: package for package in lock["source"]["packages"]}
        self.assertEqual(lock["repl"], "@strudel/repl")
        self.assertEqual(
            set(lock["files"]), {"strudel-repl.js", "strudel-LICENSE", "strudel-reference.mjs"}
        )
        self.assertEqual(lock["files"]["strudel-reference.mjs"]["package"], "@strudel/reference")
        self.assertRegex(lock["source"]["commit"], r"^[0-9a-f]{40}$")
        self.assertEqual(lock["source"]["tag"], f"@strudel/repl@{packages['@strudel/repl']['version']}")
        self.assertIn("superdough", packages)
        for name, package in packages.items():
            self.assertTrue(package["tarball"].startswith("https://registry.npmjs.org/"), name)
            algorithm, digest = FETCH.decode_integrity(package["integrity"])
            self.assertEqual((algorithm, len(digest)), ("sha512", 64), name)
        for name, pin in lock["files"].items():
            self.assertGreater(pin["bytes"], 0, name)
            self.assertTrue(re.fullmatch(r"[0-9a-f]{64}", pin["sha256"]), name)


if __name__ == "__main__":
    unittest.main()

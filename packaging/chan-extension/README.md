# Chan extension archive

Each platform archive uses one layout:

```text
chan-ext-strudel/
  strudel-extension[.exe]
  strudel.toml
  licenses/LICENSE-AGPL-3.0
  licenses/LICENSE-APACHE
  licenses/strudel-LICENSE
  source/SOURCES.md
  source/chan-ext-strudel-<version>.tar.gz
  source/npm/<package>-<version>.tgz
```

`strudel.toml` here is a template. Its `command` is a placeholder, because Chan spawns an extension with the extensions directory as its working directory and therefore needs an absolute path. The installer is what writes the real declaration, with the path it just installed to, in the target platform's own syntax.

The binary embeds the pinned `@strudel/repl` bundle and the `@strudel/reference` data and refuses to print its Chan handshake unless both match the lock. `licenses/` carries this repository's AGPL-3.0 license, Strudel's, and the Apache-2.0 license of the Chan extension scaffolding copied from the other published extensions. `source/` is the corresponding source: the pinned Strudel npm tarballs named in `runtime/strudel.lock.json`, this repository at the released commit, and `SOURCES.md` listing each tarball with its integrity digest and the Strudel monorepo tag they come from.

Tagged releases publish `chan-ext-strudel-linux-x86_64.tar.gz`, `chan-ext-strudel-linux-aarch64.tar.gz`, `chan-ext-strudel-windows-x86_64.zip`, and `chan-ext-strudel-macos-aarch64.tar.gz`. Each binary is compiled and tested on a native GitHub-hosted runner; the Linux binaries target musl, so they carry no libc dependency. `SHA256SUMS` covers all four archives, and the release also carries the root `install.sh`.

`scripts/package-chan-extension.py` assembles the archives after `scripts/fetch-strudel.py` has populated `runtime/`. Every entry is stamped with the HEAD commit time and normalized ownership, and the npm tarballs are the registry's own bytes, so packaging the same commit twice produces byte-identical archives. `scripts/install-chan-extension.sh` builds and installs from a checkout instead, for development.

The release installer detects the operating system and architecture, verifies the archive against `SHA256SUMS` before extracting anything, installs everything under `~/.local/lib/chan-ext-strudel`, writes `~/.chan/extensions/strudel.toml`, and leaves the Chan restart to the operator. Chan itself ships no Strudel files.

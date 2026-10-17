# Strudel runtime inputs

This directory holds the pinned Strudel inputs the extension embeds and ships. Only `strudel.lock.json` and this file are tracked; everything else here is fetched and verified against the lock by `scripts/fetch-strudel.py`, and ignored by git.

| path | tracked | contents |
| --- | --- | --- |
| `strudel.lock.json` | yes | npm package names, versions, tarball URLs, and registry integrity digests, plus the byte count and sha256 of each extracted file |
| `strudel-repl.js` | no | `package/dist/index.js` from the `@strudel/repl` tarball, embedded in the binary with `include_bytes!` |
| `strudel-reference.mjs` | no | `package/dist/index.mjs` from the `@strudel/reference` tarball, the documented-function data behind the reference tab, embedded the same way |
| `strudel-LICENSE` | no | `package/LICENSE` from the `@strudel/repl` tarball, shipped under `licenses/` |
| `npm/*.tgz` | no | the pinned `@strudel/*` and `superdough` tarballs, shipped under `source/npm/` as corresponding source |

`python3 scripts/fetch-strudel.py` downloads whatever is missing or stale, verifies every tarball against its integrity digest before extracting anything, and is a no-op without network once the directory matches the lock. Each entry of the lock's `files` map names the package and member it comes from. The Rust build refuses to start without the embedded files, and a test checks that each still matches the lock.

To move to a newer Strudel, edit the versions in `strudel.lock.json`, run `python3 scripts/fetch-strudel.py --pin` to refresh the URLs, integrity values, and file digests from the registry, update `source.tag` and `source.commit` from the matching tag at `https://codeberg.org/uzu/strudel/tags`, run the gate, and record the change in `CHANGELOG.md`.

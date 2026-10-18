# Contributing

Keep changes narrow, use conventional commit messages, stage explicit pathspecs, review the staged diff, and run the repository checks before committing.

## Documentation

- Describe the repository as it works now. Do not organize reference documentation around staged delivery labels, task or review language, or development-process framing.
- Keep development history only in `CHANGELOG.md`.
- Do not use em dashes. Prefer a colon, period, comma, or parentheses.
- Keep each prose paragraph and list item on one logical line. Tables, code fences, and license text retain their native formatting.

## Checks

```sh
./scripts/gate.sh
```

That fetches the pinned Strudel bundle into `runtime/` when it is missing or stale, then runs `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace`. Run it after the last edit, not before one: a check that ran before a later change proves nothing about the change.

A change to Chan's keyboard relay in `assets/app.js` also runs its focused test, which executes the relay block as shipped against keydowns from published keyboard layouts:

```sh
node --test scripts/tests/keyboard-relay.test.mjs
```

The release tooling has its own checks. `install-release.sh` packages the committed tree, so it needs at least one commit:

```sh
shellcheck install.sh scripts/*.sh scripts/tests/*.sh
python3 -m unittest discover -s scripts/tests -p 'test_*.py'
./scripts/tests/install-release.sh
```

## Updating Strudel

Change the versions in `runtime/strudel.lock.json`, then run `python3 scripts/fetch-strudel.py --pin` to refresh every tarball URL, integrity digest, and extracted-file digest from the npm registry. Set `source.tag` and `source.commit` from the matching release tag at `https://codeberg.org/uzu/strudel/tags`, run the gate, do the integration check below, and record the move in `CHANGELOG.md`. The page depends on the published `<strudel-editor>` component keeping `editor.code`, `setCode`, `appendCode`, `evaluate`, `toggle`, `updateSettings`, `repl`, and its `update` event, and on the globals Strudel publishes after prebake (`soundMap`, `themes`, `settings`, `code2hash`, `renderPatternAudio`, `initAudio`, `initAudioOnFirstClick`, `setMaxPolyphony`, `setMultiChannelOrbits`, `connectToDestination`, `getAudioContext`) and its `strudel.log` document events; a release that changes those shows up in the integration check, not in the gate.

## Integration check

Install the checkout into a running Chan and restart it:

```sh
./scripts/install-chan-extension.sh
chan devserver --restart
```

Open **Strudel** from the launcher's Apps category. Click once, press Ctrl+Enter on the default pattern, and hear it. With the editor focused, press a Chan chord such as the launcher's and confirm Chan handles it. Edit the pattern, wait a second, reload the tab, and confirm the edit came back; the record is at `~/.chan/strudel/<hex>/state.json`. In the panel: create, duplicate, and delete a pattern; hold a sound in **sounds** and hear it; search **reference** and click an example into the editor; render two cycles in **export** and find the file under `~/.chan/strudel/exports/`; watch **console** while evaluating; put a WAV under `~/.chan/strudel/samples/`, load it with `samples({x: 'name.wav'}, 'samples/')`, and hear `s("x")`; switch the theme and panel position in **settings** and reload to see them kept. Run **Toggle Strudel Presentation** from the launcher, then Restore. In the frame's browser console, `window.isSecureContext` must be true and no `SecurityError` may appear.

Finally, open the tab from a phone or a second machine through the gateway, tap once, evaluate, and reload. A local browser check does not establish gateway authentication or the touch unlock on the user's device.

Reinstall the extension before every integration run involving asset or Rust changes. The embedded assets come from the built executable.

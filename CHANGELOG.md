# Changelog

This file records notable development history and design decisions. Reference documentation describes only the repository's current behavior and contracts.

## 2026-10-18

### v0.2.0

Local samples: patterns load kits from `~/.chan/strudel/samples/` by relative URL, through Chan, from any device.

### Local samples

Serve `<data-dir>/samples` at `samples/`, so a pattern loads local files by relative URL. The URL resolves under the tab's capability path, which Chan's proxy authenticates and forwards with the extension token, so one pattern works from the desktop, over the gateway, and from another machine with no second server, port, or CORS setup. The alternative, a separate static server, works only on the machine that runs it. Each path segment must be a plain, visible name, which refuses `..`, separators, and drive prefixes. Symlinks are followed: only the user can place them, and linking a library in beats copying it. Only audio types and JSON are served, under a sandbox CSP, because the capability path shares Chan's origin and an HTML or SVG file opened from it in a top-level tab would run as Chan. Files are read whole, up to 256 MiB, which avoids a streaming dependency; Strudel reads each sample whole before decoding it anyway.

## 2026-10-17

### v0.1.0

First release: the Strudel REPL in a Chan tab with the strudel.cc shell rebuilt around it, one static binary per platform, and the Strudel sources shipped in every archive.

### Initial design

Self-host the Strudel REPL in a Chan tab as one static binary, modeled on chan-ext-mobile-chat for the server, assets, release, and install shape, and on chan-ext-doom for pinned third-party inputs, the presentation command, and shipping corresponding source. The page mounts the published `<strudel-editor>` component from the `@strudel/repl` 1.3.0 bundle unchanged; the alternative, building Strudel's Astro site, was rejected because it hardcodes a Supabase backend and reads session storage at load, which throws in Chan's opaque-origin sandbox.

License the repository AGPL-3.0-or-later to match Strudel. Chan stays Apache-2.0 and is unaffected: an extension is a separate process behind Chan's proxy and sandbox. Code copied from the Apache-licensed extensions keeps its license text in `LICENSE-APACHE`.

Keep Strudel's code out of the repository, since the Strudel project asks not to be forked back to GitHub: `runtime/strudel.lock.json` pins the npm tarballs by registry integrity digest, `scripts/fetch-strudel.py` downloads and verifies them before anything is extracted, the binary embeds the bundle with `include_bytes!`, and the server refuses to hand Chan a handshake unless the embedded bundle matches the lock. Release archives carry the pinned tarballs, a `git archive` of the repository, and a `SOURCES.md` that names the Strudel monorepo tag, so each release satisfies the license's corresponding-source terms on its own.

Save the editor text per Chan session on the devserver, because the sandbox has no local storage and a reload would otherwise lose the pattern. There is no collaboration layer: Strudel has no collaboration protocol of its own (flok provides that externally), and the extension's job is reaching one REPL through Chan. The tab ignores Chan's view-state message so music keeps playing behind another tab, and declares only the `presentation` grant.

### The strudel.cc shell

Rebuild the header buttons and the side panel of strudel.cc in the extension's own page code. They are React components of Strudel's Astro site, not of the embedded component, and the site itself cannot be self-hosted behind Chan's proxy: its assets are rooted at a fixed base path while Chan's capability path is random per process, it hardcodes a Supabase backend, and it reads session storage at module load, which throws in the opaque-origin sandbox. The rebuild drives the component's API and the globals Strudel publishes on `globalThis` after prebake, so no custom Strudel build is needed.

The session record moves to version 2, modeled on strudel.cc: a list of patterns with the active one as the editor buffer, plus settings, written whole on each change. A version 1 record becomes the first pattern. Exports render offline through Strudel's own `renderPatternAudio`; because the sandbox blocks downloads, the page captures the WAV blob by wrapping `URL.createObjectURL` for the duration of the render and posts it to the server, which stores it under `exports/` without overwriting. The reference tab ships `@strudel/reference`, pinned in the lock like the bundle. Dialogs are blocked too, so destructive buttons ask for a second click. The lock gains a top-level `files` map so a second embedded file can come from a second package.

### Worker timers

Run Strudel's scheduler on worker-backed timers. Browsers throttle a hidden or occluded page's main-thread timers to about one tick per second, and the embedded component, unlike strudel.cc, passes no timers of its own to the scheduler, so playback dragged whenever the Chan window was not in front. The page now swaps `globalThis.setInterval` and `clearInterval` for a pair backed by a dedicated worker before the editor is created, which is when Strudel's clock captures them, and hands intervals back to the native timers if the worker fails to start.

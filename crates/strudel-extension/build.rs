//! Refuse to build without the fetched Strudel inputs, with the fix spelled out.

use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let runtime = manifest.join("../../runtime");
    let embedded = ["strudel-repl.js", "strudel-reference.mjs"];
    for name in embedded.iter().chain(["strudel.lock.json"].iter()) {
        println!("cargo:rerun-if-changed={}", runtime.join(name).display());
    }
    for name in embedded {
        if !runtime.join(name).is_file() {
            eprintln!(
                "runtime/{name} is missing. Run python3 scripts/fetch-strudel.py from the \
                 repository root to download and verify the pinned Strudel packages."
            );
            std::process::exit(1);
        }
    }
}

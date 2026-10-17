#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

python3 scripts/fetch-strudel.py
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

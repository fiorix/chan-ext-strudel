#!/usr/bin/env bash
set -euo pipefail

: "${HOME:?HOME must be set}"

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
install_root=${CHAN_EXT_STRUDEL_INSTALL_ROOT:-"${HOME}/.local/lib/chan-ext-strudel"}
chan_home=${CHAN_HOME:-"${HOME}/.chan"}
binary_path="$install_root/strudel-extension"
licenses_dir="$install_root/licenses"
config_dir="$chan_home/extensions"
config_path="$config_dir/strudel.toml"

cd "$repo_root"
python3 scripts/fetch-strudel.py
cargo build --locked --release -p strudel-extension

install -d "$install_root" "$licenses_dir" "$config_dir"
install -m 0755 target/release/strudel-extension "$binary_path"
install -m 0644 LICENSE "$licenses_dir/LICENSE-AGPL-3.0"
install -m 0644 LICENSE-APACHE "$licenses_dir/LICENSE-APACHE"
install -m 0644 runtime/strudel-LICENSE "$licenses_dir/strudel-LICENSE"

toml_command=${binary_path//\\/\\\\}
toml_command=${toml_command//\"/\\\"}
config_tmp=$(mktemp "$config_path.tmp.XXXXXX")
trap 'rm -f -- "$config_tmp"' EXIT
printf 'name = "Strudel"\ncommand = "%s"\nargs = []\ncapabilities = ["presentation"]\n' \
    "$toml_command" >"$config_tmp"
chmod 0644 "$config_tmp"
mv -f -- "$config_tmp" "$config_path"
trap - EXIT

printf 'Installed Strudel at %s\nWrote the Chan declaration at %s\nRestart Chan to discover it.\n' \
    "$install_root" "$config_path"

#!/usr/bin/env bash
# Idempotently patches an installed oh-my-claudecode Claude Code plugin so its
# built-in LSP tool recognizes .fg files and spawns forge-lsp for them.
#
# Safe to re-run after any oh-my-claudecode plugin update: each patch checks
# for its own marker before touching a file, so an already-patched file is
# left untouched and a freshly-updated (unpatched) file gets re-patched.
set -euo pipefail

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
PLUGIN_ROOT_GLOB="$CLAUDE_DIR/plugins/cache/omc/oh-my-claudecode/*"

shopt -s nullglob
plugin_roots=($PLUGIN_ROOT_GLOB)
shopt -u nullglob

if [ ${#plugin_roots[@]} -eq 0 ]; then
  echo "install-claude-lsp: no oh-my-claudecode installation found under $CLAUDE_DIR/plugins/cache/omc/oh-my-claudecode/*/" >&2
  exit 1
fi

for plugin_root in "${plugin_roots[@]}"; do
  [ -d "$plugin_root" ] || continue
  echo "install-claude-lsp: patching $plugin_root"
  python3 "$(dirname "${BASH_SOURCE[0]}")/patch_forge_lsp.py" "$plugin_root"
done

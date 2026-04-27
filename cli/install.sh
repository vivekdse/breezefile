#!/usr/bin/env bash
# Symlink breeze.mjs into ~/.local/bin so `breeze` is on PATH.
# Re-run safely; -f replaces an existing symlink.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="${BREEZE_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN"
chmod +x "$HERE/breeze.mjs"
ln -sf "$HERE/breeze.mjs" "$BIN/breeze"
echo "linked $BIN/breeze -> $HERE/breeze.mjs"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "note: $BIN is not on PATH; add it to your shell rc." ;;
esac

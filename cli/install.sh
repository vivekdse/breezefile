#!/usr/bin/env bash
# Symlink the breeze launcher into ~/.local/bin so `breeze` is on PATH.
# Re-run safely; -f replaces an existing symlink.
#
# We link the POSIX shim (../bin/breeze), NOT a .mjs directly: the shim
# resolves a Node-compatible runtime (bundled Electron when packaged, or
# system node) and execs its sibling breeze.mjs. This matches both the
# packaged app and the in-app startup auto-install (ensureBreezeCli in
# electron/hooks-register.ts), so there is exactly one entry point.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SHIM="$(cd "$HERE/../bin" && pwd)/breeze"
BIN="${BREEZE_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN"
chmod +x "$SHIM" "$SHIM.mjs"
ln -sf "$SHIM" "$BIN/breeze"
echo "linked $BIN/breeze -> $SHIM"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "note: $BIN is not on PATH; add it to your shell rc." ;;
esac

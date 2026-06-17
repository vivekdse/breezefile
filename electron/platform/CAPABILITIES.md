# Platform Capabilities

Canonical list of capability flags exposed by `PlatformAdapter.capabilities()`. The renderer reads these via `usePlatform()`; verbs declare `requires: '<flag>'`. **New OS-coupled feature = new row here + new adapter method + (optionally) verb `requires`.**

| Flag                | Meaning                                                              | Mac | Linux | Windows |
|---------------------|----------------------------------------------------------------------|-----|-------|---------|
| `spotlightSearch`   | OS-level metadata index (e.g. mdfind) for cross-tree name search.    | ✓   | ✗ (we maintain our own SQLite index at `~/.breezefile/index.db`) | ✗ (same SQLite index) |
| `externalVolumes`   | Sidebar can enumerate mounted external drives.                       | ✓   | ✗ (todo) | ✓ (drive letters) |
| `cloudMounts`       | Sidebar can enumerate cloud storage providers.                       | ✓   | ✗ (todo) | ✗ (todo) |
| `attentionSound`    | Background-task chime / done sound.                                  | ✓   | ✗ (todo) | ✓ (SystemSounds) |
| `dockBadge`         | Dock/taskbar badge count for attention.                              | ✓   | ✗     | ✗ (todo: taskbar overlay) |
| `share`             | `:share` verb (native share sheet or equivalent).                    | ✓   | ✗     | ✗ |
| `colorTags`         | Finder-style color tag setting on files.                             | ✓   | ✗     | ✗ |
| `quickLook`         | Space-bar quick preview via `qlmanage`.                              | ✓   | ✗     | ✗ |
| `openWithLauncher`  | "Open With" dialog and per-extension app binding.                    | ✓   | ✗ (todo: .desktop) | ✗ (todo: ftype/assoc) |
| `vibrancy`          | Translucent window background.                                       | ✓   | ✗     | ✗ |
| `windowArrange`     | Position another app's (Chrome's) top-level window for side-by-side. | ✓ (Accessibility grant) | ✓ X11 (wmctrl/xdotool) · ✗ Wayland (degraded: own window only) | ✓ (Win32 SetWindowPos via PowerShell) |

`✗ (todo)` marks capabilities we intend to bring to parity. `✗` without `todo` is single-platform by design (no portable equivalent today).

Windows specifics: "Open With" uses the picked `.exe` directly (no `open -a`); compress/extract go through PowerShell `Compress-Archive`/`Expand-Archive` + bundled `tar.exe` (zip/tar); `.dmg` is refused (mac-only); the terminal verb opens Windows Terminal (`wt.exe`) or `cmd.exe` with no chooser; app upgrade opens the GitHub releases page (no Homebrew).

# Platform Capabilities

Canonical list of capability flags exposed by `PlatformAdapter.capabilities()`. The renderer reads these via `usePlatform()`; verbs declare `requires: '<flag>'`. **New OS-coupled feature = new row here + new adapter method + (optionally) verb `requires`.**

| Flag                | Meaning                                                              | Mac | Linux |
|---------------------|----------------------------------------------------------------------|-----|-------|
| `spotlightSearch`   | OS-level metadata index (e.g. mdfind) for cross-tree name search.    | ✓   | ✗ (we maintain our own SQLite index at `~/.breezefile/index.db`) |
| `externalVolumes`   | Sidebar can enumerate mounted external drives.                       | ✓   | ✗ (todo) |
| `cloudMounts`       | Sidebar can enumerate cloud storage providers.                       | ✓   | ✗ (todo) |
| `attentionSound`    | Background-task chime / done sound.                                  | ✓   | ✗ (todo) |
| `dockBadge`         | Dock/taskbar badge count for attention.                              | ✓   | ✗     |
| `share`             | `:share` verb (native share sheet or equivalent).                    | ✓   | ✗     |
| `colorTags`         | Finder-style color tag setting on files.                             | ✓   | ✗     |
| `quickLook`         | Space-bar quick preview via `qlmanage`.                              | ✓   | ✗     |
| `openWithLauncher`  | "Open With" dialog and per-extension app binding.                    | ✓   | ✗ (todo: .desktop) |
| `vibrancy`          | Translucent window background.                                       | ✓   | ✗     |

`✗ (todo)` marks capabilities we intend to bring to parity. `✗` without `todo` is single-platform by design (no portable equivalent today).

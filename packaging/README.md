# Packaging & distribution

Unsigned macOS app delivered via a personal Homebrew cask tap. No Apple Developer account.

## Build locally

```sh
npm run build                    # tsc + vite build (renderer + main + preload)
npx electron-builder --mac       # produces release/*.dmg and release/*.zip
```

Artifacts land in `release/`. `shasum -a 256 release/*.dmg` gives the sha256 for the cask.

## Automated release

Push a tag matching `v*`:

```sh
git tag v0.1.0 && git push --tags
```

`.github/workflows/release.yml` runs on `macos-14`, builds arm64 + x64 dmg/zip, and uploads them to a GitHub Release along with `shasums.txt`.

## Tap setup (one-time)

1. Create a public repo named `homebrew-tap` under your GitHub user (e.g. `vivekdse/homebrew-tap`).
2. Copy `packaging/file-manager.rb.template` → `Casks/file-manager.rb` in that repo.
3. Fill in `OWNER/REPO` with the release repo path.
4. Commit.

## Publishing each release

For every release, run in the tap repo:

```sh
# Replace VERSION and SHA256 from shasums.txt for the arm64 dmg
sed -i '' "s|VERSION|0.1.0|g; s|SHA256|<sha256>|g" Casks/file-manager.rb
git commit -am "file-manager 0.1.0" && git push
```

Users install with:

```sh
brew tap <user>/tap
brew install --cask file-manager
```

The `preflight` block in the cask strips the macOS quarantine attribute so Gatekeeper doesn't block the unsigned app on first launch.

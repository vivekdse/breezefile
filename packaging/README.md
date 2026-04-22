# Packaging & distribution

Unsigned macOS app delivered via a personal Homebrew cask tap. No Apple Developer account.

## Build locally

```sh
npm run build                                      # tsc + vite build (renderer + main + preload)
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac   # produces release/*.dmg + release/*.zip
```

Artifacts land in `release/Breezefile-<version>-arm64.dmg` and
`release/Breezefile-<version>-x64.dmg`. `shasum -a 256 release/*.dmg`
gives the sha256 values for the cask.

## Automated release

Push a tag matching `v*`:

```sh
git tag v0.1.0 && git push --tags
```

`.github/workflows/release.yml` runs on `macos-14`, builds arm64 + x64
dmg/zip, and uploads them to a GitHub Release along with `shasums.txt`.

## Tap setup (one-time)

1. Create a public repo `vivekdse/homebrew-tap` on GitHub.
2. Copy `packaging/breezefile.rb.template` → `Casks/breezefile.rb` in the tap repo.
3. Fill in VERSION + ARM64SHA + X64SHA from `shasums.txt`.
4. Commit + push.

## Publishing each release

For every release, run in the tap repo:

```sh
# From shasums.txt of the release:
ARM64SHA=$(grep arm64.dmg shasums.txt | awk '{print $2}')
X64SHA=$(grep -E 'Breezefile-[0-9.]+-x64\.dmg' shasums.txt | awk '{print $2}')

sed -i '' \
  -e "s|VERSION|0.1.0|g" \
  -e "s|ARM64SHA|$ARM64SHA|g" \
  -e "s|X64SHA|$X64SHA|g" \
  Casks/breezefile.rb

git commit -am "breezefile 0.1.0" && git push
```

Users install with:

```sh
brew tap vivekdse/tap
brew install --cask breezefile
```

The `preflight` block in the cask strips the macOS quarantine attribute
so Gatekeeper doesn't block first launch of the unsigned app.

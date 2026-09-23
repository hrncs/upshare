# Changelog

## [0.0.20] - 2026-09-24

### Added
- **Beta upgrades**: Added `upshare upgrade --beta` to install the latest beta release. Plain `upshare upgrade` and the background update check stay on stable releases only.
- **Update check opt-out**: Added `--no-update-check` flag and `UPSHARE_NO_UPDATE_CHECK=1` to skip the background update check. Checks are also skipped automatically in CI and piped output.

### Changed
- Version comparison is now prerelease-aware, so prereleases are never offered to stable users while beta users still get newer betas and stables.
- `upshare --version` no longer hits the network and uses the cached check instead, making it instant and offline-safe.
- Background update checks now time out after 800ms instead of 1200ms.
- Dependency updates: commander 15, ora 9, zod 4.6, keyring 2.1, typescript 7, vitest 5, @types/node 26, biome 2.5.14.

## [0.0.19] - 2026-09-22

### Changed
- Replaced loopback browser callbacks with the OAuth 2.0 Device Authorization Grant. Browser approvals now use expiring, one-time server-side authorization records and the CLI polls the token endpoint using RFC 8628 semantics.

## [0.0.18] - 2026-09-08

### Added
- **Download Force Overwrite**: Added `-f, --force` flag to `upshare download` to allow overwriting an existing local destination file.
- **Quota Warnings on Modified Files**: Alert users when an interrupted multipart upload is invalidated due to local file changes, guiding them to run `upshare abort` to reclaim held quota.

### Fixed
- **Download Completion on External Drives**: Replaced hardlinks with atomic `fs.renameSync` and automatic fallback to `copyFileSync` + `unlinkSync` on `EXDEV`, `ENOTSUP`, and `EPERM` (supports FAT32/exFAT drives, SD cards, and cross-volume mounts).
- **Graceful Ctrl+C Exits**: Cleanly exit with code 0 instead of throwing an unhandled rejection when `Ctrl+C` is pressed in `upshare manage`, `upshare delete`, or `upshare abort`.
- **Upload Stream Descriptor Leak**: Wrapped chunk streams in `try ... finally` to guarantee immediate descriptor destruction on upload network failures or timeouts.
- **Exponential Backoff on Multipart Completion**: Added exponential backoff (1s, 2s, 4s) when finalizing uploads on transient 500+ server responses instead of rapid 0ms retry storms.
- **URL Sanitization**: Strip trailing slashes from share URLs and download identifiers before resolution.

## [0.0.17] - 2026-09-07

### Added
- **Browser Authentication**: Added `upshare signup` and `upshare login --web` with automatic loopback callback server for browser-based login and account creation.
- **Headless Support**: Added `--no-browser` flag for `login --web` and `signup` on headless servers and SSH sessions.
- **API Key Management**: Added `upshare keys` to list account API keys with creation and last-used timestamps, and `upshare keys rename` to rename keys by ID, prefix, or `current`.
- **Account Details**: Added active API key prefix and relative key age to `upshare whoami`.
- **Redesigned Loopback Pages**: Polished local HTTP callback landing pages (`CLI Connected` and error states).

### Changed
- Improved `upshare logout` to verify and purge OS credential storage directly and respect `--api-url`.

# Changelog

## [0.0.21] - 2026-09-24

### Added
- **`list --json`**: machine-readable JSON output for scripting (merges all pages with `--all`).
- **Typed file IDs**: `f_`-prefixed file IDs (`f_` + 21-char nanoid) for deterministic share/file routing. Share tokens stay bare and short for URLs.
- **Legacy ID fallback**: bare 21-char file IDs (pre-backfill saves, scripts, `upload-state.json`) resolve via one `f_+bare` retry; server accepts both during the compat window.
- **409 finalize retry**: `upload-complete` 409 `in_progress` honors `Retry-After` (cap 30s, 3 attempts); `invalid_state` still fails fast.

### Changed
- **BREAKING**: bare `upshare --api-url <url>` no longer silently persists to the profile; it errors with a hint to `profile add <name> --api-url <url>`.
- **BREAKING**: `--all` and `--page` are now strictly mutually exclusive for `list` (previously `--all --page 1` was allowed).
- **BREAKING**: `profile list/use/show/remove` now error on `--api-url`/`--profile` instead of silently ignoring them (`profile add` still honors `--api-url`).
- **BREAKING**: `share`/`extend` no longer send `extendMasterFile: true`; file expiry is left alone to match the web UI.
- Upload `--concurrency` is `1-16` (was briefly `1-32`); the server caps part-URL batches at 16.
- Share/extend `--duration` minimum is `0.5h` to match the server (file retention `--hours` stays `1-168`).
- `download` routing is prefix-based (`f_...` → file path first, else share-token first) instead of length-guessing; happy path stays one request.
- Device-auth verification URLs enforce `https` (localhost `http` allowed) + `/cli/authorize` pathname; a differing origin (app URL vs `--api-url`) warns instead of throwing.
- Health check simplified to ok/unreachable against `/api/health`; accepts `status` or `state` check shapes.
- Status `finalizing` and all six list sorts accepted instead of throwing “unexpected response”.

### Fixed
- Upload stream errors forwarded (no 6h hang); single-part retries refresh signed URLs; refresh failures retried; empty part-URL guarded.
- Download resume corruption reports exact paths with `--force` restart; chunk-size drift warns and restarts; EXDEV/ENOTSUP/EPERM fallback cleans truncated dest; journal close can’t mask real errors.
- Abort: pure target resolver, first-page quota snapshot, 100-page cap, batched parallel deletes with per-ID reasons, sanitized names.
- Shared confirm prompt (`delete`/`abort`/`profile remove`): non-TTY demands `--yes`, Ctrl+C exits 130.
- Manage: link creation disclosed and confirmed, looped pagination, `getFile()` lookup, typo re-prompts.
- Login: unicode/ctrl-key handling, loud non-TTY echo warning, no hardcoded `✓`. Signup no longer blocked by `UPSHARE_API_KEY`. Logout no false-failure probe, canonical key format with error reasons.
- Keys prefix match requires 4+ chars; ambiguous matches reported distinctly; dropped `this` alias.
- Rename validates length/controls client-side; info no longer swallows auth/network as “retry upload”; share/extend deduped via helper.
- Upgrade detects `dlx`/`bunx`/Volta/Yarn Berry correctly with explicit npm priority; 404 vs offline distinguished.
- Config loads once per resolution, skips single bad profiles, specific error kinds; credentials lazily cached; `slow_down` capped; zero-byte progress/`NaN%` guards; strict duration/integer parsing.
- Ranged downloads use loop workers with 120s chunk timeouts and `.part` preflight; journals cap at 10MB and only drop provably-torn tails.

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

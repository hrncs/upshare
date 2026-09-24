# UpShare CLI

[![Tests & Build](https://github.com/hrncs/upshare/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hrncs/upshare/actions/workflows/ci.yml)
[![Release & Publish](https://github.com/hrncs/upshare/actions/workflows/release.yml/badge.svg)](https://github.com/hrncs/upshare/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/upshare?color=blue)](https://www.npmjs.com/package/upshare)
[![issues](https://img.shields.io/github/issues/hrncs/upshare)](https://github.com/hrncs/upshare/issues)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Official command-line interface for [UpShare](https://upshare.app). Upload,
download, share, and manage your files from your terminal.

## Installation & Usage

Requires Node.js >= 22

```bash
# Run directly with npx
npx upshare --help

# Or install globally
npm install -g upshare
```

## Upgrading

```bash
# Upgrade to the latest version (upgrade, update)
upshare upgrade

# Upgrade to the latest beta version
upshare upgrade --beta
```

Set `UPSHARE_NO_UPDATE_CHECK=1` (or pass `--no-update-check`) to skip the background update check, e.g. in CI.

## Commands

### 1. Authentication
```bash
# Create an account via browser.
# This creates an API key and saves it automatically.
upshare signup

# Authenticate with your API key (obtained from the web dashboard)
upshare login

# Log in to (or create) a specific profile
upshare login -p own

# Log in via browser 
upshare login --web

# List API keys for this account
upshare keys

# Rename an API key by id, prefix, name, or `current`
upshare keys rename <key> <name>

# Print the verification URL and code for headless machines
upshare login --web --no-browser
upshare signup --no-browser

# Check authenticated account profile and monthly upload limit
upshare whoami

# Clear the active profile's stored credential (keeps its API URL)
upshare logout

# Remove stored credentials for all API URLs (e.g. prod + localhost)
upshare logout --all
```

Browser login uses the OAuth 2.0 Device Authorization Grant. The verification
code expires after ten minutes and can issue credentials only once. The API key
remains valid until you revoke it.

For CI or headless environments, inject the key as `UPSHARE_API_KEY`. The
environment variable takes precedence over the active profile's stored
credential and is never persisted by the CLI.

### 2. Profiles

Each profile binds one domain to one account, so personal, work, and
self-hosted servers can coexist. Two profiles may point at the same domain
with different accounts.

```bash
# Add a profile for a self-hosted server (defaults to https://upshare.app)
upshare profile add own --api-url https://files.example.com

# Log in to it (also makes it the active profile)
upshare login -p own

# Run any command against a non-active profile without switching
upshare upload ./report.pdf -p own
upshare list -p work

# Switch the active profile
upshare profile use work

# Inspect profiles
upshare profile list
upshare profile show own

# Remove a profile and its stored credential
upshare profile remove own --yes
```

Profile names are lowercase letters, numbers, `_`, `-` (max 64 chars).
Resolution order: `-p/--profile` flag, then `UPSHARE_PROFILE`, then the
profile set with `profile use`, then `default`. `--api-url` (flag or
`UPSHARE_API_URL`) always overrides the profile's domain, and
`UPSHARE_API_KEY` always overrides its stored credential — nothing is
hardcoded to one domain.

### 3. Uploading Files
```bash
# Upload and automatically generate a public share link (default 24 hours)
upshare upload ./document.pdf

# Specify file retention in hours (1-168)
upshare upload ./archive.zip --hours 72

# Upload privately without generating a public share link
upshare upload ./secrets.env --no-share

# Upload with a custom share link expiration (e.g. share link expires in 2 hours)
upshare upload ./preview.png --hours 48 -d 2
```

Large files resume where they left off by re-running the same upload command.

If you stop an upload halfway, it still blocks space until you free it. Run
`upshare abort` to get that space back.

### 4. Aborting Unfinished Uploads
```bash
# Show unfinished uploads and remove them (prompts for confirmation)
upshare abort

# Abort a single unfinished upload by its file ID
upshare abort <fileId>

# Skip confirmation prompt
upshare abort --yes
```

The optional target must be an unfinished upload ID (as listed by
`upshare abort` or `upshare list --pending`). Active files are never deleted
through this command.

### 5. List Files
```bash
# List the 20 most recent active files (list, ls)
upshare list

# List the next 20 files
upshare list --page 2

# List every active file
upshare list --all

# List partial uploads holding space
upshare list --pending
```

### 6. Sharing & Links
```bash
# Create or retrieve a share link (default: 24 hours)
upshare share <fileId-or-token>

# Create a share link with custom duration in hours (0.5-168)
upshare share <fileId-or-token> --duration 48

# Extend the duration of an active share link
upshare extend <fileId-or-token> --duration 72

# Revoke a public share link (makes file private)
upshare revoke <fileId-or-token>
```

### 7. Downloading Files
```bash
# Download by public share link URL
upshare download https://upshare.app/s/abcdef12

# Download by share token or file ID to a custom directory
upshare download abcdef12 --out ./downloads

# Overwrite existing local file if it already exists
upshare download abcdef12 --force

# Tune concurrent range downloads and retries (defaults: 8 streams, 5 retries)
upshare download abcdef12 --concurrency 16 --retries 10
```

### 8. Deleting Files
```bash
# Delete a file permanently (delete, rm; prompts for confirmation)
upshare delete <fileId-or-token>

# Skip confirmation prompt
upshare delete <fileId-or-token> --yes
```

### 9. Renaming Files
```bash
# Rename an uploaded file 
upshare rename <fileId-or-token> "Dunder-Mifflin-2026-Audit.pdf"
```

### 10. Interactive File Manager
```bash
# Launch interactive terminal file manager (manage, files)
upshare manage
```

### 11. File Details
```bash
# Show everything about one file: size, expiry, share link, views
upshare info <fileId-or-token>
```

### 12. API Status
```bash
# Check UpShare API status
upshare status
```

## Global & Command Options

- `--hours <hours>`: Changes default file retention period in hours (1–168, default: `24`).
- `--concurrency <count>`: Sets concurrent transfers (1–16 for uploads, 1–16 for downloads). The default is `16` for uploads and `8` for downloads.
- `--retries <count>`: Sets retries for failed transfers (0–20, default: `5`).
- `--no-share`: Skip creating a public share link; keeps the file private in your dashboard.
- `-d, --share-duration <hours>`: Set the share duration when uploading (0.5–168).
- `-d, --duration <hours>`: Set the duration when creating or extending a share link (0.5–168).
- `-o, --out <dir>`: Choose the download directory.
- `-f, --force`: Overwrite existing destination file when downloading; restart a corrupted resume state.
- `-y, --yes`: Skip confirmation prompts when aborting unfinished uploads, deleting files, or removing profiles.
- `--page <page>`: Page number for `list` (mutually exclusive with `--all`).
- `--all`: List all files (mutually exclusive with `--page`).
- `--pending`: List partial uploads holding space (`list --pending`).
- `--json`: Output `list` results as JSON for scripting.
- `--beta`: Upgrade to the latest beta (`upgrade --beta`).
- `-w, --web`: Log in / sign up via browser. `--no-browser` prints the URL instead of opening it.
- `--no-update-check`: Skip the background update check (or set `UPSHARE_NO_UPDATE_CHECK=1`).
- `--api-url <url>`: Per-run override of UpShare backend URL (default: `https://upshare.app`). Not persisted; use `profile add <name> --api-url <url>` to persist.
- `-p, --profile <name>`: Run against a specific profile (or set `UPSHARE_PROFILE`).

>API keys are stored per profile in Windows Credential Manager, macOS
>Keychain, or Linux Secret Service. `~/.upshare/config.json` contains only
>non-secret settings and key prefixes. Use `upshare logout` to remove the
>active profile's stored credential (its domain is kept), `upshare profile
>remove <name>` to drop a profile entirely, or `upshare logout --all` to
>remove everything. On a headless Linux system without Secret Service,
>provide `UPSHARE_API_KEY` through your CI or process secret manager. Custom
>API URLs must use HTTPS, except for localhost development.
## License

[MIT](LICENSE) © 2026 Himanshu Ranjan

# UpShare CLI

[![Tests & Build](https://github.com/hrncs/upshare/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hrncs/upshare/actions/workflows/ci.yml)
[![Release & Publish](https://github.com/hrncs/upshare/actions/workflows/release.yml/badge.svg)](https://github.com/hrncs/upshare/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/upshare?color=blue)](https://www.npmjs.com/package/upshare)
[![issues](https://img.shields.io/github/issues/hrncs/upshare)](https://github.com/hrncs/upshare/issues)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Official command-line interface for [UpShare](https://upshare.app). Upload,
download, share, and manage your files from your terminal.

## Installation & Usage

Requires Node.js 20.11 or newer.

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
```

## Commands

### 1. Authentication
```bash
# Create an account via browser.
# This creates an API key and saves it automatically.
upshare signup

# Authenticate with your API key (obtained from the web dashboard)
upshare login

# Log in via browser 
upshare login --web

# List API keys for this account
upshare keys

# Rename an API key by id, prefix, name, or `current`
upshare keys rename <key> <name>

# Print the browser URL for headless machines
upshare login --web --no-browser
upshare signup --no-browser

# Check authenticated account profile and monthly upload limit
upshare whoami

# Clear stored credentials
upshare logout
```

For CI or headless environments, inject the key as `UPSHARE_API_KEY`. The
environment variable takes precedence and is never persisted by the CLI.

### 2. Uploading Files
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

### 3. Aborting Unfinished Uploads
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

### 4. List Files
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

### 5. Sharing & Links
```bash
# Create or retrieve a share link (default: 24 hours)
upshare share <fileId-or-token>

# Create a share link with custom duration in hours (1-168)
upshare share <fileId-or-token> --duration 48

# Extend the duration of an active share link
upshare extend <fileId-or-token> --duration 72

# Revoke a public share link (makes file private)
upshare revoke <fileId-or-token>
```

### 6. Downloading Files
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

### 7. Deleting Files
```bash
# Delete a file permanently (delete, rm; prompts for confirmation)
upshare delete <fileId-or-token>

# Skip confirmation prompt
upshare delete <fileId-or-token> --yes
```

### 8. Renaming Files
```bash
# Rename an uploaded file 
upshare rename <fileId-or-token> "Dunder-Mifflin-2026-Audit.pdf"
```

### 9. Interactive File Manager
```bash
# Launch interactive terminal file manager (manage, files)
upshare manage
```

### 10. File Details
```bash
# Show everything about one file: size, expiry, share link, views
upshare info <fileId-or-token>
```

## Global & Command Options

- `--hours <hours>`: Changes default file retention period in hours (1–168, default: `24`).
- `--concurrency <count>`: Sets concurrent transfers (1–16). The default is `16` for uploads and `8` for downloads.
- `--retries <count>`: Sets retries for failed transfers (0–20, default: `5`).
- `--no-share`: Skip creating a public share link; keeps the file private in your dashboard.
- `-d, --share-duration <hours>`: Set the share duration when uploading.
- `-d, --duration <hours>`: Set the duration when creating or extending a share link.
- `-o, --out <dir>`: Choose the download directory.
- `-f, --force`: Overwrite existing destination file when downloading.
- `-y, --yes`: Skip confirmation prompts when aborting unfinished uploads or deleting files.
- `--api-url <url>`: Override UpShare backend URL (default: `https://upshare.app`).

>API keys are stored in Windows Credential Manager, macOS Keychain, or Linux
>Secret Service. `~/.upshare/config.json` contains only non-secret settings and a
>key prefix. Use `upshare logout` to remove the stored credential. On a
>headless Linux system without Secret Service, provide `UPSHARE_API_KEY` through
>your CI or process secret manager. Custom API URLs must use HTTPS, except for
>localhost development.
## License

[MIT](LICENSE) © 2026 Himanshu Ranjan

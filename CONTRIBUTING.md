# Contributing to UpShare CLI

## Prerequisites

- **Node.js**: `>= 20.11`
- **Package Manager**: `pnpm`

## Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/himanshuranjan/upshare.git
   cd upshare
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

3. Build the CLI:
   ```bash
   pnpm build
   ```

## Development & Verification

Before submitting a pull request, ensure all checks and tests pass:

- **Format**: `pnpm format` (formats code using Biome)
- **Lint**: `pnpm check` (Ultracite / Biome checks)
- **Typecheck**: `pnpm check-types` (`tsc --noEmit`)
- **Tests**: `pnpm test` (Vitest test suite)
- **Build**: `pnpm build` (`tsdown` bundle)

You can run the full suite at once with:
```bash
pnpm prepublishOnly
```

## Pull Request Guidelines

- Create a feature branch from `master` (`git checkout -b feature/your-feature-name`).
- Keep PRs focused on a single change, fix, or improvement.
- Ensure all existing and new tests pass.
- Use clear, conventional commit messages (`feat: ...`, `fix: ...`, `docs: ...`, `chore: ...`).
- Complete the checklist provided in the pull request template.

set -euo pipefail

VERSION="${1:?usage: build-release-notes.sh <version> <output-file|--check>}"
TARGET="${2:?usage: build-release-notes.sh <version> <output-file|--check>}"

extract_section() {
  awk -v v="$VERSION" '
    $0 ~ "^## \\[" v "\\]" {flag=1; next}
    /^## \[/ && flag {exit}
    flag' CHANGELOG.md
}

release_title() {
  local msg highlight title
  msg=$(git log -1 --format=%s)
  highlight=$(printf '%s' "$msg" | sed -n 's/^release: v[^:]*: //p')
  title="v${VERSION}"
  if [ -n "$highlight" ]; then
    title="${title}: ${highlight}"
  fi
  printf '%s' "$title"
}

SECTION=$(extract_section)
TITLE=$(release_title)

if [ -z "$SECTION" ]; then
  echo "error: no CHANGELOG.md section for [${VERSION}]" >&2
  exit 1
fi
if [ -z "$TITLE" ]; then
  echo "error: empty release title" >&2
  exit 1
fi

if [ "$TARGET" = "--check" ]; then
  echo "notes OK for v${VERSION}: ${TITLE}"
  exit 0
fi

GENERATED=$(gh api "repos/${GITHUB_REPOSITORY:?}/releases/generate-notes" \
  -f tag_name="v${VERSION}" -f target_commitish=main --jq .body)
{
  echo "## v${VERSION}"
  echo ""
  printf '%s\n\n' "$SECTION"
  printf '%s\n' "$GENERATED"
} > "$TARGET"
printf '%s' "$TITLE"

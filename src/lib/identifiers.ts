const TOKEN_DELIMITER_REGEX = /[?#]/;
const TRAILING_SLASHES_REGEX = /\/+$/;

export function isFileId(id: string): boolean {
  return id.startsWith("f_");
}

export function cleanIdentifier(target: string): string {
  const withoutOuterSlashes = target.trim().replace(TRAILING_SLASHES_REGEX, "");
  if (!withoutOuterSlashes) {
    return "";
  }
  if (withoutOuterSlashes.includes("/s/")) {
    const segments = withoutOuterSlashes.split("/s/");

    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const segment = segments[i]
        ?.split(TOKEN_DELIMITER_REGEX)[0]
        ?.replace(TRAILING_SLASHES_REGEX, "");
      if (segment) {
        return segment;
      }
    }
    return "";
  }
  return withoutOuterSlashes.split(TOKEN_DELIMITER_REGEX)[0] ?? "";
}

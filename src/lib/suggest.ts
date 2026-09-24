export interface SuggestableCommand {
  aliases?: readonly string[];
  name: string;
}

const MAX_SUGGESTION_DISTANCE = 3;

export function editDistance(
  a: string,
  b: string,
  maxDistance = Number.POSITIVE_INFINITY
): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  const m = x.length;
  const n = y.length;
  if (m === 0) {
    return n;
  }
  if (n === 0) {
    return m;
  }
  if (Math.abs(m - n) > maxDistance) {
    return maxDistance + 1;
  }
  if (y.startsWith(x)) {
    return n - m;
  }
  if (x.startsWith(y)) {
    return m - n;
  }

  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1).fill(0);
  let prevPrev = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    let [rowMin] = curr;
    for (let j = 1; j <= n; j += 1) {
      const substitutionCost = x[i - 1] === y[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + substitutionCost
      );
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) {
        curr[j] = Math.min(curr[j], prevPrev[j - 2] + 1);
      }
      if (curr[j] < rowMin) {
        rowMin = curr[j];
      }
    }
    if (rowMin > maxDistance) {
      return maxDistance + 1;
    }
    [prevPrev, prev, curr] = [prev, curr, prevPrev];
  }
  return prev[n];
}

export function suggestCommand(
  input: string,
  commands: readonly SuggestableCommand[]
): string | null {
  const normalized = input.toLowerCase();
  if (normalized.length === 0) {
    return null;
  }

  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const { aliases = [], name } of commands) {
    for (const candidate of [name, ...aliases]) {
      const distance = editDistance(normalized, candidate, bestDistance);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = name;
      }
    }
  }

  if (best === null) {
    return null;
  }

  const threshold = Math.min(
    MAX_SUGGESTION_DISTANCE,
    Math.max(1, Math.floor(Math.max(normalized.length, best.length) / 3))
  );
  return bestDistance <= threshold ? best : null;
}

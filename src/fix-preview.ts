import type { FixPreview } from "./types";

export function previewLineMatches(
  before: readonly string[],
  after: readonly string[],
): Array<[number, number]> {
  const matches: Array<[number, number]> = [];

  function match(
    beforeStart: number,
    beforeEnd: number,
    afterStart: number,
    afterEnd: number,
  ): void {
    while (
      beforeStart < beforeEnd &&
      afterStart < afterEnd &&
      before[beforeStart] === after[afterStart]
    ) {
      matches.push([beforeStart++, afterStart++]);
    }

    const suffix: Array<[number, number]> = [];

    while (
      beforeStart < beforeEnd &&
      afterStart < afterEnd &&
      before[beforeEnd - 1] === after[afterEnd - 1]
    ) {
      suffix.push([--beforeEnd, --afterEnd]);
    }

    const rows = beforeEnd - beforeStart;
    const columns = afterEnd - afterStart;

    if (rows > 0 && columns > 0) {
      if ((rows + 1) * (columns + 1) <= 250_000) {
        const dp = Array.from(
          { length: rows + 1 },
          () => new Uint32Array(columns + 1),
        );

        for (let left = rows - 1; left >= 0; left--) {
          for (let right = columns - 1; right >= 0; right--) {
            dp[left][right] =
              before[beforeStart + left] === after[afterStart + right]
                ? dp[left + 1][right + 1] + 1
                : Math.max(dp[left + 1][right], dp[left][right + 1]);
          }
        }

        let left = 0;
        let right = 0;

        while (left < rows && right < columns) {
          if (before[beforeStart + left] === after[afterStart + right]) {
            matches.push([beforeStart + left++, afterStart + right++]);
          } else if (dp[left + 1][right] >= dp[left][right + 1]) left++;
          else right++;
        }
      } else {
        const diagonalEnds = new Map<number, number>([[1, 0]]);
        const trace: Map<number, number>[] = [];
        let work = 0;

        search: for (let distance = 0; distance <= 256; distance++) {
          trace.push(new Map(diagonalEnds));

          for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
            const down = diagonalEnds.get(diagonal + 1) ?? 0;
            const across = diagonalEnds.get(diagonal - 1) ?? 0;

            let left =
              diagonal === -distance || (diagonal !== distance && across < down)
                ? down
                : across + 1;

            let right = left - diagonal;

            while (
              left < rows &&
              right < columns &&
              before[beforeStart + left] === after[afterStart + right]
            ) {
              left++;
              right++;

              if (++work > 500_000) break search;
            }

            if (++work > 500_000) break search;

            diagonalEnds.set(diagonal, left);

            if (left < rows || right < columns) continue;

            const middle: Array<[number, number]> = [];

            for (let step = distance; step >= 0; step--) {
              const ends = trace[step];
              const currentDiagonal = left - right;

              const previousDiagonal =
                currentDiagonal === -step ||
                (currentDiagonal !== step &&
                  (ends.get(currentDiagonal - 1) ?? 0) <
                    (ends.get(currentDiagonal + 1) ?? 0))
                  ? currentDiagonal + 1
                  : currentDiagonal - 1;

              const previousLeft = ends.get(previousDiagonal) ?? 0;
              const previousRight = previousLeft - previousDiagonal;

              while (left > previousLeft && right > previousRight) {
                middle.push([beforeStart + --left, afterStart + --right]);
              }

              left = previousLeft;
              right = previousRight;
            }

            for (const pair of middle.reverse()) matches.push(pair);

            break search;
          }
        }
      }
    }

    for (const pair of suffix.reverse()) matches.push(pair);
  }

  match(0, before.length, 0, after.length);

  return matches;
}

export function compactFixPreview(preview: FixPreview): FixPreview {
  const before = preview.before.split(/\r?\n/);
  const after = preview.after.split(/\r?\n/);

  if (Math.max(before.length, after.length) <= 14) return preview;

  const matches: Array<[number, number]> = [
    [-1, -1],
    ...previewLineMatches(before, after),
    [before.length, after.length],
  ];

  const beforeVisible = new Set<number>();
  const afterVisible = new Set<number>();

  const keep = (
    visible: Set<number>,
    start: number,
    end: number,
    length: number,
  ) => {
    for (
      let index = Math.max(0, start - 2);
      index < Math.min(length, end + 2);
      index++
    )
      visible.add(index);
  };

  for (let index = 1; index < matches.length; index++) {
    const [previousBefore, previousAfter] = matches[index - 1];
    const [nextBefore, nextAfter] = matches[index];

    if (nextBefore === previousBefore + 1 && nextAfter === previousAfter + 1)
      continue;

    keep(beforeVisible, previousBefore + 1, nextBefore, before.length);
    keep(afterVisible, previousAfter + 1, nextAfter, after.length);
  }

  if (beforeVisible.size === 0 && afterVisible.size === 0) return preview;

  const compact = (lines: string[], visible: Set<number>): string => {
    const result: string[] = [];
    let omitted = 0;

    const flush = () => {
      if (omitted > 0) {
        result.push(
          `-- … ${omitted} unchanged ${omitted === 1 ? "line" : "lines"} omitted`,
        );

        omitted = 0;
      }
    };

    lines.forEach((line, index) => {
      if (visible.has(index)) {
        flush();
        result.push(line);
      } else omitted++;
    });

    flush();

    return result.join("\n");
  };

  return {
    ...preview,
    before: compact(before, beforeVisible),
    after: compact(after, afterVisible),
  };
}

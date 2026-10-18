function longBracketEquals(source: string, start: number): number | null {
  if (source[start] !== "[") return null;

  let index = start + 1;

  while (source[index] === "=") index += 1;

  return source[index] === "[" ? index - start - 1 : null;
}

function longBracketEnd(source: string, start: number, equals: number): number {
  const closer = `]${"=".repeat(equals)}]`;
  const end = source.indexOf(closer, start + equals + 2);

  return end < 0 ? source.length : end + closer.length;
}

function skipQuoted(source: string, start: number, quote: string): number {
  let cursor = start + 1;
  let escaped = false;

  while (cursor < source.length) {
    const current = source[cursor];
    cursor += 1;

    if (escaped) escaped = false;
    else if (current === "\\") escaped = true;
    else if (current === quote) break;
  }

  return cursor;
}

/** Blanks comments while keeping every string, offset, and line break intact */
export function sourceWithoutComments(source: string): string {
  const parts: string[] = [];
  let start = 0;
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (char === "'" || char === '"' || char === "`") {
      index = skipQuoted(source, index, char);
      continue;
    }

    if (char === "[") {
      const equals = longBracketEquals(source, index);

      if (equals !== null) {
        index = longBracketEnd(source, index, equals);
        continue;
      }
    }

    if (char === "-" && source[index + 1] === "-") {
      const longEquals = longBracketEquals(source, index + 2);

      const end =
        longEquals === null
          ? source.indexOf("\n", index + 2)
          : longBracketEnd(source, index + 2, longEquals);

      const stop = end < 0 ? source.length : end;
      parts.push(source.slice(start, index), source.slice(index, stop).replace(/[^\r\n]/g, " "));
      start = stop;
      index = stop;
      continue;
    }

    index += 1;
  }

  return parts.length === 0 ? source : parts.join("") + source.slice(start);
}

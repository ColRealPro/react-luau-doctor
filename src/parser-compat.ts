interface BracketDepth {
  parentheses: number;
  brackets: number;
  braces: number;
}

interface Range {
  start: number;
  end: number;
}

function scanTypeLine(text: string, depth: BracketDepth): void {
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "-" && next === "-") break;

    if (char === "(") depth.parentheses += 1;
    else if (char === ")") depth.parentheses = Math.max(0, depth.parentheses - 1);
    else if (char === "[") depth.brackets += 1;
    else if (char === "]") depth.brackets = Math.max(0, depth.brackets - 1);
    else if (char === "{") depth.braces += 1;
    else if (char === "}") depth.braces = Math.max(0, depth.braces - 1);
  }
}

function depthIsZero(depth: BracketDepth): boolean {
  return depth.parentheses === 0 && depth.brackets === 0 && depth.braces === 0;
}

function lineData(source: string): { lines: string[]; offsets: number[] } {
  const lines = source.match(/[^\n]*(?:\n|$)/g)?.filter((line, index, all) => line.length > 0 || index < all.length - 1) ?? [source];
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length;
  }
  return { lines, offsets };
}

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

/**
 * Marks executable-code positions. Strings and comments are false so syntax
 * compatibility rewrites never alter text that merely contains a keyword.
 */
function codeMask(source: string): Uint8Array {
  const mask = new Uint8Array(source.length);
  mask.fill(1);

  let index = 0;
  while (index < source.length) {
    const char = source[index];

    if (char === "'" || char === "\"") {
      const quote = char;
      let cursor = index;
      let escaped = false;
      while (cursor < source.length) {
        mask[cursor] = 0;
        const current = source[cursor];
        cursor += 1;
        if (cursor - 1 === index) continue;
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === quote) break;
      }
      index = cursor;
      continue;
    }

    if (char === "`") {
      let cursor = index;
      let escaped = false;
      while (cursor < source.length) {
        mask[cursor] = 0;
        const current = source[cursor];
        cursor += 1;
        if (cursor - 1 === index) continue;
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === "`") break;
      }
      index = cursor;
      continue;
    }

    if (char === "-" && source[index + 1] === "-") {
      const longEquals = longBracketEquals(source, index + 2);
      const end = longEquals === null ? source.indexOf("\n", index + 2) : longBracketEnd(source, index + 2, longEquals);
      const stop = end < 0 ? source.length : end;
      mask.fill(0, index, stop);
      index = stop;
      continue;
    }

    if (char === "[") {
      const equals = longBracketEquals(source, index);
      if (equals !== null) {
        const end = longBracketEnd(source, index, equals);
        mask.fill(0, index, end);
        index = end;
        continue;
      }
    }

    index += 1;
  }

  return mask;
}

function isCode(mask: Uint8Array, start: number, end = start + 1): boolean {
  for (let index = start; index < end; index += 1) {
    if (mask[index] !== 1) return false;
  }
  return true;
}

function maskTypeAliases(source: string, mask: Uint8Array): Range[] {
  const { lines, offsets } = lineData(source);
  const ranges: Range[] = [];
  const typeStart = /^(\s*)(?:export\s+)?type\s+[A-Za-z_][A-Za-z0-9_]*(?:<[^>]*>)?\s*=/;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex].replace(/\r?\n$/, "");
    const match = line.match(typeStart);
    if (!match || !isCode(mask, offsets[lineIndex] + match.index!, offsets[lineIndex] + match.index! + match[0].trimStart().length)) continue;

    const depth: BracketDepth = { parentheses: 0, brackets: 0, braces: 0 };
    let sawExpression = false;
    let endLine = lineIndex;

    for (let current = lineIndex; current < lines.length; current += 1) {
      const currentLine = lines[current].replace(/\r?\n$/, "");
      const segment = current === lineIndex ? currentLine.slice(match[0].length) : currentLine;
      if (segment.trim().length > 0) sawExpression = true;
      scanTypeLine(segment, depth);
      endLine = current;

      if (!sawExpression || !depthIsZero(depth)) continue;
      const trimmed = segment.trimEnd();
      if (/[|&=,]$/.test(trimmed)) continue;

      let nextNonEmpty = "";
      for (let lookahead = current + 1; lookahead < lines.length; lookahead += 1) {
        nextNonEmpty = lines[lookahead].trim();
        if (nextNonEmpty.length > 0) break;
      }
      if (/^[|&]/.test(nextNonEmpty)) continue;
      break;
    }

    ranges.push({
      start: offsets[lineIndex],
      end: offsets[endLine] + lines[endLine].length,
    });
    lineIndex = endLine;
  }

  return ranges;
}

function maskTypeLevelBlocks(source: string, mask: Uint8Array): Range[] {
  const { lines, offsets } = lineData(source);
  const ranges: Range[] = [];
  const declarationStart = /^(\s*)(?:(?:export\s+)?type\s+function\b|declare\s+(?:extern\s+type|class|global)\b)/;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex].replace(/\r?\n$/, "");
    const match = line.match(declarationStart);
    if (!match) continue;
    const firstToken = offsets[lineIndex] + match[1].length;
    if (!isCode(mask, firstToken)) continue;

    const indentation = match[1].replace(/\t/g, "    ").length;
    let endLine = lineIndex;
    const afterStart = line.slice(match[0].length);
    if (!/\bend\b/.test(afterStart)) {
      for (let current = lineIndex + 1; current < lines.length; current += 1) {
        const currentLine = lines[current].replace(/\r?\n$/, "");
        const trimmed = currentLine.trim();
        if (!trimmed) continue;
        const currentIndent = currentLine.match(/^\s*/)?.[0].replace(/\t/g, "    ").length ?? 0;
        if (trimmed === "end" && currentIndent <= indentation && isCode(mask, offsets[current] + currentLine.indexOf("end"), offsets[current] + currentLine.indexOf("end") + 3)) {
          endLine = current;
          break;
        }
      }
    }

    ranges.push({ start: offsets[lineIndex], end: offsets[endLine] + lines[endLine].length });
    lineIndex = endLine;
  }

  return ranges;
}

function attributeRanges(source: string, mask: Uint8Array): Range[] {
  const ranges: Range[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "@" || !isCode(mask, index)) continue;

    if (source[index + 1] === "[") {
      let depth = 0;
      let cursor = index + 1;
      while (cursor < source.length) {
        if (isCode(mask, cursor)) {
          if (source[cursor] === "[") depth += 1;
          else if (source[cursor] === "]") {
            depth -= 1;
            if (depth === 0) {
              cursor += 1;
              break;
            }
          }
        }
        cursor += 1;
      }
      ranges.push({ start: index, end: cursor });
      index = cursor - 1;
      continue;
    }

    const match = source.slice(index + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (match && isCode(mask, index + 1, index + 1 + match[0].length)) {
      ranges.push({ start: index, end: index + 1 + match[0].length });
      index += match[0].length;
    }
  }
  return ranges;
}

function explicitTypeArgumentRanges(source: string, mask: Uint8Array): Range[] {
  const ranges: Range[] = [];
  for (let index = 0; index < source.length - 1; index += 1) {
    if (source[index] !== "<" || source[index + 1] !== "<" || !isCode(mask, index, index + 2)) continue;

    let depth = 2;
    let cursor = index + 2;
    while (cursor < source.length && depth > 0) {
      if (isCode(mask, cursor)) {
        if (source[cursor] === "<") depth += 1;
        else if (source[cursor] === ">") depth -= 1;
      }
      cursor += 1;
    }
    if (depth === 0) {
      ranges.push({ start: index, end: cursor });
      index = cursor - 1;
    }
  }
  return ranges;
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges.filter((range) => range.end > range.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Range[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function blankPreservingUtf8Bytes(value: string): string {
  let result = "";
  for (const char of value) {
    if (char === "\n" || char === "\r") result += char;
    else result += " ".repeat(new TextEncoder().encode(char).length);
  }
  return result;
}

function applyMasks(source: string, ranges: Range[]): string {
  let output = source;
  for (const range of mergeRanges(ranges).sort((a, b) => b.start - a.start)) {
    output = `${output.slice(0, range.start)}${blankPreservingUtf8Bytes(output.slice(range.start, range.end))}${output.slice(range.end)}`;
  }
  return output;
}

function genericFunctionParameterRanges(source: string, mask: Uint8Array): Range[] {
  const ranges: Range[] = [];
  const functionPattern = /\bfunction\b/g;

  for (const match of source.matchAll(functionPattern)) {
    const start = match.index;
    if (!isCode(mask, start, start + match[0].length)) continue;

    let cursor = start + match[0].length;
    while (cursor < source.length) {
      const char = source[cursor];
      if (/\s/.test(char)) {
        cursor += 1;
        continue;
      }
      if (char === "(") break;
      if (char === "<") {
        let depth = 0;
        const rangeStart = cursor;
        while (cursor < source.length) {
          if (isCode(mask, cursor)) {
            if (source[cursor] === "<") depth += 1;
            else if (source[cursor] === ">") {
              depth -= 1;
              if (depth === 0) {
                cursor += 1;
                ranges.push({ start: rangeStart, end: cursor });
                break;
              }
            }
          }
          cursor += 1;
        }
        break;
      }

      if (/[A-Za-z0-9_.:]/.test(char)) {
        cursor += 1;
        continue;
      }
      break;
    }
  }

  return ranges;
}

// The bundled grammar understands variadic types (`...T`) but not generic
// type-pack references (`T...`). Reorder only pack uses outside a function's
// generic declaration so Tree-sitter sees an equal-width type node.
function normalizeGenericTypePackUses(source: string, mask: Uint8Array): string {
  const declarationRanges = genericFunctionParameterRanges(source, mask);
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const packPattern = /\b[A-Za-z_][A-Za-z0-9_]*\.\.\./g;

  for (const match of source.matchAll(packPattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!isCode(mask, start, end)) continue;
    if (declarationRanges.some((range) => start >= range.start && end <= range.end)) continue;

    const name = match[0].slice(0, -3);
    replacements.push({ start, end, value: `...${name}` });
  }

  let output = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }
  return output;
}

function normalizeIntegerLiteralSuffixes(source: string, mask: Uint8Array): string {
  const suffixes: number[] = [];
  const integerPattern = /\b(?:0[xX][0-9A-Fa-f_]+|0[bB][01_]+|[0-9][0-9_]*)i\b/g;

  for (const match of source.matchAll(integerPattern)) {
    const start = match.index;
    const suffix = start + match[0].length - 1;
    if (isCode(mask, start, suffix + 1)) suffixes.push(suffix);
  }

  let output = source;
  for (const suffix of suffixes.sort((a, b) => b - a)) {
    output = `${output.slice(0, suffix)} ${output.slice(suffix + 1)}`;
  }
  return output;
}

function replaceContextualKeywords(source: string, mask: Uint8Array): string {
  const replacements: Array<{ start: number; end: number; value: string }> = [];

  const constPattern = /\bconst\b(?=\s+(?:function\b|[A-Za-z_][A-Za-z0-9_]*\s*(?::|,|=)))/g;
  for (const match of source.matchAll(constPattern)) {
    const start = match.index;
    if (isCode(mask, start, start + 5)) replacements.push({ start, end: start + 5, value: "local" });
  }

  const exportPattern = /\bexport\b(?=\s+(?:local\b|const\b|function\b))/g;
  for (const match of source.matchAll(exportPattern)) {
    const start = match.index;
    if (isCode(mask, start, start + 6)) replacements.push({ start, end: start + 6, value: "      " });
  }

  let output = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }
  return output;
}

/**
 * Adapts syntax added after the bundled Tree-sitter grammar without moving any
 * UTF-8 byte offsets. Runtime declarations are normalized to older equivalent
 * syntax; type-only syntax and attributes are blanked because React analysis
 * does not need their AST nodes.
 */
export function parserCompatibleSource(source: string): string {
  const mask = codeMask(source);
  const keywordCompatible = replaceContextualKeywords(source, mask);
  const literalCompatible = normalizeIntegerLiteralSuffixes(keywordCompatible, mask);
  const packCompatible = normalizeGenericTypePackUses(literalCompatible, mask);
  const ranges = [
    ...maskTypeAliases(source, mask),
    ...maskTypeLevelBlocks(source, mask),
    ...attributeRanges(source, mask),
    ...explicitTypeArgumentRanges(source, mask),
  ];
  const masked = applyMasks(packCompatible, ranges);

  // tree-sitter-luau 1.2.0 treats a statement-level assignment to the valid
  // Luau identifier `type` as a malformed type alias. Replace only that token
  // with an equal-width identifier so syntax locations remain aligned.
  return masked.replace(
    /^(\s*)type(?=\s*(?:\+=|-=|\*=|\/=|%=|\^=|\.\.=|=(?!=)))/gm,
    "$1_typ",
  );
}

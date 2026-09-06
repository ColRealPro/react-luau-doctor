import assert from "node:assert/strict";
import test from "node:test";
import { parserCompatibleSource } from "../src/parser-compat";

test("modern syntax compatibility preserves UTF-8 byte length and line positions", () => {
  const source = `@[deprecated("héllo")]
export const Component = function()
\tconst integer = 1_000i
end
`;
  const compatible = parserCompatibleSource(source);

  assert.equal(Buffer.byteLength(compatible, "utf8"), Buffer.byteLength(source, "utf8"));
  assert.equal(compatible.split("\n").length, source.split("\n").length);
});

test("compatibility rewrites modern tokens only in executable code", () => {
  const source = `const value = 123i
local quoted = "const untouched = 456i"
local interpolated = \`const untouched = 789i\`
-- const untouched = 321i
`;
  const compatible = parserCompatibleSource(source);

  assert.match(compatible, /^local value = 123 /);
  assert.match(compatible, /"const untouched = 456i"/);
  assert.match(compatible, /`const untouched = 789i`/);
  assert.match(compatible, /-- const untouched = 321i/);
});

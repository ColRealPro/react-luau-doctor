import assert from "node:assert/strict";
import test from "node:test";
import { parserCompatibleSource } from "../src/parser-compat";
import { parseLuau } from "../src/parser";

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

test("generic type pack uses are normalized without changing declarations or source positions", async () => {
  const source = `local function changeDirectorState<Args...>(
	transform: (State, Args...) -> State,
	...: Args...
)
	return transform(state, ...)
end
`;
  const compatible = parserCompatibleSource(source);

  assert.match(compatible, /changeDirectorState<Args\.\.\.>/);
  assert.match(compatible, /\(State, \.\.\.Args\) -> State/);
  assert.match(compatible, /\.\.\.: \.\.\.Args/);
  assert.equal(Buffer.byteLength(compatible, "utf8"), Buffer.byteLength(source, "utf8"));
  assert.equal(compatible.split("\n").length, source.split("\n").length);

  const tree = await parseLuau(source);
  assert.equal(tree.rootNode.hasError, false);
});

test("typeof local annotations parse without changing executable initializers", async () => {
  const source = `local useReduxContext: typeof(useDefaultReduxContext) = if context == ReactReduxContext
	then useDefaultReduxContext
	else function()
		return React.useContext(context)
	end
`;
  const compatible = parserCompatibleSource(source);

  assert.match(compatible, /local useReduxContext: any\s+= if context == ReactReduxContext/);
  assert.match(compatible, /return React\.useContext\(context\)/);
  assert.equal(Buffer.byteLength(compatible, "utf8"), Buffer.byteLength(source, "utf8"));
  assert.equal(compatible.split("\n").length, source.split("\n").length);

  const tree = await parseLuau(source);
  assert.equal(tree.rootNode.hasError, false);
});

test("generic function return types parse without masking the function body", async () => {
  const source = `local createSelectorHook = function(context: React.Context?): <TState, Selected>(
	selector: (state: TState) -> Selected,
	equalityFn: EqualityFn<Selected>?
) -> Selected
	local value = React.useMemo(function()
		return context
	end, { context })
	return value
end
`;
  const compatible = parserCompatibleSource(source);

  assert.doesNotMatch(compatible, /<TState, Selected>/);
  assert.match(compatible, /Selected\n\tlocal value = React\.useMemo/);
  assert.equal(Buffer.byteLength(compatible, "utf8"), Buffer.byteLength(source, "utf8"));
  assert.equal(compatible.split("\n").length, source.split("\n").length);

  const tree = await parseLuau(source);
  assert.equal(tree.rootNode.hasError, false);
});

test("react-redux typed hook syntax parses without cascading errors", async () => {
  const source = `local useReduxContext: typeof(useDefaultReduxContext) = if context == ReactReduxContext
	then useDefaultReduxContext
	else function()
		return React.useContext(context)
	end

local createStoreHook = function(context: React.Context?): <State, Action>() -> Store<State, Action>
	return function<State, Action>()
		local instRef = React.useRef(nil :: {
			hasValue: true,
			value: State,
		} | {
			hasValue: false,
		} | nil)
		return instRef
	end
end
`;

  const tree = await parseLuau(source);
  assert.equal(tree.rootNode.hasError, false);
});

test("react-redux compatibility leaves runtime typeof and ordinary return annotations unchanged", () => {
  const source = `local kind = typeof(value)
local getValue = function(): number return value end
`;

  assert.equal(parserCompatibleSource(source), source);
});

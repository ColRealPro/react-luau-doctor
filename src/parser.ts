import { buildLuauSyntaxTree, type LuauSyntaxTree } from "./luau-syntax";
import { LuauParser } from "./luau-wasm";
import { timeWork } from "./timings";

let parserPromise: Promise<LuauParser> | null = null;

export async function parseLuau(source: string): Promise<LuauSyntaxTree> {
  parserPromise ??= LuauParser.load();
  const parser = await parserPromise;

  const output = parser.parse(source);

  return timeWork("Parse/Build tree", () => buildLuauSyntaxTree(source, output));
}

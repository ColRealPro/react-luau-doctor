import { buildLuauSyntaxTree, type LuauSyntaxTree } from "./luau-syntax";
import { LuauParser } from "./luau-wasm";

let parserPromise: Promise<LuauParser> | null = null;

export async function parseLuau(source: string): Promise<LuauSyntaxTree> {
  parserPromise ??= LuauParser.load();
  const parser = await parserPromise;

  return buildLuauSyntaxTree(source, parser.parse(source));
}

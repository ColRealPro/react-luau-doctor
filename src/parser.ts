import fs from "node:fs";
import path from "node:path";
import { Language, Parser } from "web-tree-sitter";
import type { SyntaxTree } from "./syntax";
import { parserCompatibleSource } from "./parser-compat";

let parserPromise: Promise<Parser> | null = null;

async function createParser(): Promise<Parser> {
  await Parser.init();
  const grammarPath = path.resolve(import.meta.dir, "../vendor/tree-sitter-luau.wasm");
  const grammar = new Uint8Array(fs.readFileSync(grammarPath));
  const language = await Language.load(grammar);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

async function getParser(): Promise<Parser> {
  parserPromise ??= createParser();
  return parserPromise;
}

export async function parseLuau(source: string): Promise<SyntaxTree> {
  const parser = await getParser();
  const tree = parser.parse(parserCompatibleSource(source));
  if (!tree) throw new Error("Tree-sitter failed to parse Luau source");
  return tree;
}

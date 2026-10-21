import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LuauParseOutput } from "./luau-syntax";
import { timeWork } from "./timings";

interface LuauExports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  luau_alloc(size: number): number;
  luau_free(pointer: number): void;
  luau_parse(source: number, length: number): number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class LuauParser {
  private constructor(private readonly exports: LuauExports) {}

  static async load(wasmPath = defaultWasmPath()): Promise<LuauParser> {
    const bytes = fs.readFileSync(wasmPath);

    const { instance } = await WebAssembly.instantiate(bytes, {
      env: { emscripten_notify_memory_growth() {} },
    });

    const exports = instance.exports as unknown as LuauExports;
    exports._initialize();

    return new LuauParser(exports);
  }

  parse(source: string): LuauParseOutput {
    const encoded = encoder.encode(source);
    const pointer = this.exports.luau_alloc(encoded.length + 1);

    try {
      const result = timeWork("Parse/Luau WASM", () => {
        new Uint8Array(this.exports.memory.buffer, pointer, encoded.length).set(encoded);

        return this.exports.luau_parse(pointer, encoded.length);
      });

      return timeWork("Parse/Decode JSON", () => {
        const memory = new Uint8Array(this.exports.memory.buffer);
        const end = memory.indexOf(0, result);

        return JSON.parse(decoder.decode(memory.subarray(result, end)));
      });
    } finally {
      this.exports.luau_free(pointer);
    }
  }
}

function defaultWasmPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../vendor/luau-parser.wasm");
}

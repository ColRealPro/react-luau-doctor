import fs from "node:fs";
import path from "node:path";

// Rebuilds vendor/luau-parser.wasm from a pinned Luau release. Requires an
// activated Emscripten SDK so `em++` is on PATH
const LUAU_VERSION = "0.743";

const root = path.resolve(import.meta.dir, "..");
const checkout = path.join(root, ".cache", `luau-${LUAU_VERSION}`);
const output = path.join(root, "vendor", "luau-parser.wasm");

function run(command: string[], cwd = root): void {
  const result = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit" });

  if (result.exitCode !== 0) throw new Error(`${command[0]} exited with ${result.exitCode}`);
}

if (!fs.existsSync(checkout)) {
  fs.mkdirSync(path.dirname(checkout), { recursive: true });
  run(["git", "clone", "--depth", "1", "--branch", LUAU_VERSION, "https://github.com/luau-lang/luau.git", checkout]);
}

const sources = [
  ...["Ast/src", "Common/src"].flatMap((dir) =>
    fs.readdirSync(path.join(checkout, dir)).filter((file) => file.endsWith(".cpp")).map((file) => path.join(checkout, dir, file)),
  ),
  path.join(root, "native", "luau-parser", "encode.cpp"),
];

const compiler = process.platform === "win32" ? "em++.exe" : "em++";

run([
  process.env.EMSDK ? path.join(process.env.EMSDK, "upstream", "emscripten", compiler) : compiler,
  "-Oz",
  "-std=c++17",
  "-fwasm-exceptions",
  "-DNDEBUG",
  `-I${path.join(checkout, "Common", "include")}`,
  `-I${path.join(checkout, "Ast", "include")}`,
  ...sources,
  "--no-entry",
  "-sSTANDALONE_WASM=1",
  "-sALLOW_MEMORY_GROWTH=1",
  "-sINITIAL_MEMORY=4194304",
  "-sSTACK_SIZE=1048576",
  "-sEXPORTED_FUNCTIONS=_luau_parse,_luau_alloc,_luau_free",
  "-o",
  output,
]);

fs.copyFileSync(path.join(checkout, "LICENSE.txt"), path.join(root, "vendor", "luau.LICENSE"));
console.log(`Built ${path.relative(root, output)} (${fs.statSync(output).size} bytes) from Luau ${LUAU_VERSION}`);

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const outdir = path.join(root, "dist");
fs.rmSync(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [path.join(root, "src", "cli.ts")],
  outdir,
  target: "bun",
  format: "esm",
  sourcemap: "linked",
  packages: "external",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`Built ${result.outputs.length} files with Bun ${Bun.version}`);


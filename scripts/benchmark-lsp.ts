import fs from "node:fs";
import path from "node:path";
import { parseLuau } from "../src/parser";
import { buildReactModel } from "../src/ast/react-model";
import { analyzeReactFile } from "../src/file-analysis";

import {
  buildProjectModel,
  type ProjectModelModuleCacheEntry,
} from "../src/project-model";

import { buildProjectSourceEffects } from "../src/project-effects";

const root = path.resolve(import.meta.dir, "..");

const absolutePath = path.join(
  root,
  "tests",
  "fixtures",
  "large-codebase-regressions.luau",
);

const source = fs.readFileSync(absolutePath, "utf8");

const file = {
  absolutePath,
  relativePath: "large-codebase-regressions.luau",
  source,
};

const modules = new Map<string, ProjectModelModuleCacheEntry>();

const project = buildProjectModel(root, [file], {
  fileHashes: { [file.relativePath]: "same" },
  moduleCache: modules,
});

const tree = await parseLuau(source);

async function measure(
  name: string,
  count: number,
  action: () => unknown | Promise<unknown>,
) {
  const values: number[] = [];

  for (let i = 0; i < count + 3; i++) {
    const start = performance.now();
    await action();

    if (i >= 3) values.push(performance.now() - start);
  }

  values.sort((a, b) => a - b);

  console.log(
    `${name}: median ${values[Math.floor(values.length / 2)].toFixed(2)} ms, p95 ${values[Math.ceil(values.length * 0.95) - 1].toFixed(2)} ms`,
  );
}

console.log(
  `Fixture: ${file.relativePath}, ${Buffer.byteLength(source)} bytes`,
);

await measure("parse/preprocess", 40, async () =>
  (await parseLuau(source)).delete?.(),
);

await measure("buildReactModel", 40, () =>
  buildReactModel(tree.rootNode, project),
);

await measure("analyzeReactFile, supplied tree", 40, () =>
  analyzeReactFile(
    {
      ...file,
      forceScan: true,
      project,
      config: {},
      minSeverity: "suggestion",
      respectInlineDisables: true,
    },
    tree,
  ),
);

await measure("warm project model", 40, () =>
  buildProjectModel(root, [file], {
    fileHashes: { [file.relativePath]: "same" },
    moduleCache: modules,
  }),
);

await measure("source effects, cold", 10, () =>
  buildProjectSourceEffects(root, [file]),
);

const effect = await buildProjectSourceEffects(
  root,
  [file],
  undefined,
  undefined,
  { [file.relativePath]: "same" },
);

await measure("source effects, cached", 40, () =>
  buildProjectSourceEffects(
    root,
    [file],
    undefined,
    undefined,
    { [file.relativePath]: "same" },
    effect.cacheModules,
  ),
);

tree.delete?.();

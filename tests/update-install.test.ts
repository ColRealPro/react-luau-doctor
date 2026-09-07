import assert from "node:assert/strict";
import test from "node:test";
import packageJson from "../package.json";
import { updateInstallCommandForPath } from "../src/update-install";

const spec = `${packageJson.name}@latest`;

test("global update command follows Bun global installations", () => {
  assert.deepEqual(
    updateInstallCommandForPath(`/home/test/.bun/install/global/node_modules/${packageJson.name}/dist/cli.js`),
    {
      manager: "bun",
      command: "bun",
      args: ["add", "-g", spec],
      display: `bun add -g ${spec}`,
    },
  );
});

test("global update command follows npm global installations", () => {
  assert.deepEqual(
    updateInstallCommandForPath(`/usr/local/lib/node_modules/${packageJson.name}/dist/cli.js`),
    {
      manager: "npm",
      command: "npm",
      args: ["install", "-g", spec],
      display: `npm install -g ${spec}`,
    },
  );
});

test("one-off and source checkouts are not mutated by doctor update", () => {
  assert.equal(updateInstallCommandForPath(`/home/test/.bun/install/cache/${packageJson.name}/dist/cli.js`), null);
  assert.equal(updateInstallCommandForPath(`/home/test/.npm/_npx/123/node_modules/${packageJson.name}/dist/cli.js`), null);
  assert.equal(updateInstallCommandForPath(`/home/test/Projects/react-luau-doctor/src/update-install.ts`), null);
});

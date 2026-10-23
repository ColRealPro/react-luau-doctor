import { expect, test } from "bun:test";
import packageJson from "../package.json";
import { updateInstallCommandForPath } from "../src/update-install";

const spec = `${packageJson.name}@latest`;

test("global update command follows Bun global installations", () => {
  expect(updateInstallCommandForPath(`/home/test/.bun/install/global/node_modules/${packageJson.name}/dist/cli.js`)).toEqual({
      manager: "bun",
      command: "bun",
      args: ["add", "-g", spec],
      display: `bun add -g ${spec}`,
    });
});

test("global update command follows npm global installations", () => {
  expect(updateInstallCommandForPath(`/usr/local/lib/node_modules/${packageJson.name}/dist/cli.js`)).toEqual({
      manager: "npm",
      command: "npm",
      args: ["install", "-g", spec],
      display: `npm install -g ${spec}`,
    });
});

test("one-off and source checkouts are not mutated by doctor update", () => {
  expect(updateInstallCommandForPath(`/home/test/.bun/install/cache/${packageJson.name}/dist/cli.js`)).toBe(null);
  expect(updateInstallCommandForPath(`/home/test/.npm/_npx/123/node_modules/${packageJson.name}/dist/cli.js`)).toBe(null);
  expect(updateInstallCommandForPath(`/home/test/Projects/react-luau-doctor/src/update-install.ts`)).toBe(null);
});

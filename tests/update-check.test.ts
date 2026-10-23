import { expect, test, onTestFinished } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  changelogReleasesBetween,
  checkForUpdatesNow,
  refreshUpdateCache,
  getCachedUpdateNotice,
} from "../src/update-check";

function withUpdateCache(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-update-"));
  const previous = process.env.REACT_LUAU_DOCTOR_CACHE_DIR;
  process.env.REACT_LUAU_DOCTOR_CACHE_DIR = root;
  onTestFinished(() => {
    if (previous === undefined) delete process.env.REACT_LUAU_DOCTOR_CACHE_DIR;
    else process.env.REACT_LUAU_DOCTOR_CACHE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("changelog parsing returns only published releases between installed and latest", () => {
  const markdown = `# Changelog

## Unreleased

- This should not be shown yet.

## [0.19.0] - 2026-09-10

### Added
- This should not be shown before npm publishes it.

## 0.18.4

### Fixed
- Reduced binding false positives.

## v0.18.3 - 2026-09-08

### Performance
- Faster project scans.

## 0.18.2

- Already installed.
`;
  expect(changelogReleasesBetween(markdown, "0.18.2", "0.18.4")).toEqual([
    { version: "0.18.4", notes: "### Fixed\n- Reduced binding false positives." },
    { version: "0.18.3", notes: "### Performance\n- Faster project scans." },
  ]);
});

test("cached update notices remain visible until the installed version catches up", async () => {
  withUpdateCache();
  const previousRegistry = process.env.REACT_LUAU_DOCTOR_UPDATE_REGISTRY;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return Response.json({ version: "0.18.2" }); } });
  process.env.REACT_LUAU_DOCTOR_UPDATE_REGISTRY = server.url.toString();
  onTestFinished(() => {
    server.stop(true);
    if (previousRegistry === undefined) delete process.env.REACT_LUAU_DOCTOR_UPDATE_REGISTRY;
    else process.env.REACT_LUAU_DOCTOR_UPDATE_REGISTRY = previousRegistry;
  });

  await refreshUpdateCache();
  expect(getCachedUpdateNotice("0.18.1")).toEqual({ current: "0.18.1", latest: "0.18.2" });
  expect(getCachedUpdateNotice("0.18.1")).toEqual({ current: "0.18.1", latest: "0.18.2" });
  expect(getCachedUpdateNotice("0.18.2")).toBe(null);
});

test("manual update checks force a registry refresh without consuming the cached notice", async () => {
  withUpdateCache();
  const previousRegistry = process.env.REACT_LUAU_DOCTOR_UPDATE_REGISTRY;
  let requests = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { requests += 1; return Response.json({ version: "0.18.3" }); } });
  process.env.REACT_LUAU_DOCTOR_UPDATE_REGISTRY = server.url.toString();
  onTestFinished(() => {
    server.stop(true);
    if (previousRegistry === undefined) delete process.env.REACT_LUAU_DOCTOR_UPDATE_REGISTRY;
    else process.env.REACT_LUAU_DOCTOR_UPDATE_REGISTRY = previousRegistry;
  });

  const result = await checkForUpdatesNow("0.18.1");
  expect(result).toEqual({ latest: "0.18.3", updateAvailable: true });
  expect(requests).toBe(1);
  expect(getCachedUpdateNotice("0.18.1")).toEqual({ current: "0.18.1", latest: "0.18.3" });
});

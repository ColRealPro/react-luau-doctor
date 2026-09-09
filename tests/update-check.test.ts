import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  UPDATE_CHECK_INTERVAL_MS,
  changelogReleasesBetween,
  checkForUpdatesNow,
  compareVersions,
  fetchChangelogReleases,
  refreshUpdateCache,
  getCachedUpdateNotice,
  updateCacheIsStale,
} from "../src/update-check";

function withUpdateCache(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "react-luau-doctor-update-"));
  const previous = process.env.REACT_LUAU_DOCTOR_CACHE_DIR;
  process.env.REACT_LUAU_DOCTOR_CACHE_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.REACT_LUAU_DOCTOR_CACHE_DIR;
    else process.env.REACT_LUAU_DOCTOR_CACHE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("version comparison handles stable and prerelease releases", () => {
  assert.equal(compareVersions("0.18.2", "0.18.1"), 1);
  assert.equal(compareVersions("0.18.1", "0.18.1"), 0);
  assert.equal(compareVersions("0.18.0", "0.18.1"), -1);
  assert.equal(compareVersions("0.19.0-beta.2", "0.19.0-beta.1"), 1);
  assert.equal(compareVersions("0.19.0", "0.19.0-beta.2"), 1);
});

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
  assert.deepEqual(changelogReleasesBetween(markdown, "0.18.2", "0.18.4"), [
    { version: "0.18.4", notes: "### Fixed\n- Reduced binding false positives." },
    { version: "0.18.3", notes: "### Performance\n- Faster project scans." },
  ]);
});

test("changelog fetch reads the configured remote changelog", async (t) => {
  const previous = process.env.REACT_LUAU_DOCTOR_CHANGELOG_URL;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return new Response("## 0.18.4\n\n### Added\n- Release notes in update checks.\n", {
        headers: { "content-type": "text/markdown" },
      });
    },
  });
  process.env.REACT_LUAU_DOCTOR_CHANGELOG_URL = server.url.toString();
  t.after(() => {
    server.stop(true);
    if (previous === undefined) delete process.env.REACT_LUAU_DOCTOR_CHANGELOG_URL;
    else process.env.REACT_LUAU_DOCTOR_CHANGELOG_URL = previous;
  });

  assert.deepEqual(await fetchChangelogReleases("0.18.3", "0.18.4"), [
    { version: "0.18.4", notes: "### Added\n- Release notes in update checks." },
  ]);
});

test("update cache uses a two hour refresh interval", async (t) => {
  withUpdateCache(t);
  const previousRegistry = process.env.REACT_LUAU_DOCTOR_UPDATE_REGISTRY;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return Response.json({ version: "0.18.2" }); } });
  process.env.REACT_LUAU_DOCTOR_UPDATE_REGISTRY = server.url.toString();
  t.after(() => {
    server.stop(true);
    if (previousRegistry === undefined) delete process.env.REACT_LUAU_DOCTOR_UPDATE_REGISTRY;
    else process.env.REACT_LUAU_DOCTOR_UPDATE_REGISTRY = previousRegistry;
  });

  const checkedAt = 1_000_000;
  assert.equal(updateCacheIsStale(checkedAt), true);
  await refreshUpdateCache({ now: checkedAt });
  assert.equal(updateCacheIsStale(checkedAt + UPDATE_CHECK_INTERVAL_MS - 1), false);
  assert.equal(updateCacheIsStale(checkedAt + UPDATE_CHECK_INTERVAL_MS), true);
});

test("cached update notices remain visible until the installed version catches up", async (t) => {
  withUpdateCache(t);
  const previousRegistry = process.env.REACT_LUAU_DOCTOR_UPDATE_REGISTRY;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return Response.json({ version: "0.18.2" }); } });
  process.env.REACT_LUAU_DOCTOR_UPDATE_REGISTRY = server.url.toString();
  t.after(() => {
    server.stop(true);
    if (previousRegistry === undefined) delete process.env.REACT_LUAU_DOCTOR_UPDATE_REGISTRY;
    else process.env.REACT_LUAU_DOCTOR_UPDATE_REGISTRY = previousRegistry;
  });

  await refreshUpdateCache();
  assert.deepEqual(getCachedUpdateNotice("0.18.1"), { current: "0.18.1", latest: "0.18.2" });
  assert.deepEqual(getCachedUpdateNotice("0.18.1"), { current: "0.18.1", latest: "0.18.2" });
  assert.equal(getCachedUpdateNotice("0.18.2"), null);
});

test("manual update checks force a registry refresh without consuming the cached notice", async (t) => {
  withUpdateCache(t);
  const previousRegistry = process.env.REACT_LUAU_DOCTOR_UPDATE_REGISTRY;
  let requests = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { requests += 1; return Response.json({ version: "0.18.3" }); } });
  process.env.REACT_LUAU_DOCTOR_UPDATE_REGISTRY = server.url.toString();
  t.after(() => {
    server.stop(true);
    if (previousRegistry === undefined) delete process.env.REACT_LUAU_DOCTOR_UPDATE_REGISTRY;
    else process.env.REACT_LUAU_DOCTOR_UPDATE_REGISTRY = previousRegistry;
  });

  const result = await checkForUpdatesNow("0.18.1");
  assert.deepEqual(result, { latest: "0.18.3", updateAvailable: true });
  assert.equal(requests, 1);
  assert.deepEqual(getCachedUpdateNotice("0.18.1"), { current: "0.18.1", latest: "0.18.3" });
});

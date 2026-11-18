import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { worktreeFingerprintMaterial } from "./snapshot.js";

test("a broken changed symlink is fingerprinted without dereferencing it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "herdr-review-snapshot-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.symlink("../missing-target", path.join(root, "broken-link"));

  const material = await worktreeFingerprintMaterial({
    root,
    files: [{ path: "broken-link", status: "A" }],
    hashFiles: async (paths) => {
      assert.deepEqual(paths, [], "a symlink must not be passed to git hash-object");
      return "";
    },
  });

  assert.match(material, /broken-link/);
  assert.match(material, /\.\.\/missing-target/);
});

test("Herdr passes the repository root into snapshot fingerprinting", async () => {
  const source = await fs.readFile(new URL("./main.js", import.meta.url), "utf8");
  assert.match(
    source,
    /worktreeFingerprintMaterial\(\{\s*root,\s*files,/,
    "gitSnapshot must pass its resolved repository root to the filesystem helper",
  );
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("curation smoke must not recall after an unfinished retain times out", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-curation-timeout-"));
  try {
    await mkdir(join(root, ".hindsight"));
    await writeFile(
      join(root, ".hindsight", "coding-agent.json"),
      JSON.stringify({ apiUrl: "http://localhost:1" }),
    );
    const preload = join(root, "preload.mjs");
    await writeFile(
      preload,
      `let now = 0;
Date.now = () => now;
globalThis.fetch = async (url) => {
  if (url.includes("/operations/")) {
    now = 1_000_000;
    return new Response(JSON.stringify({ status: "processing" }));
  }
  if (url.includes("/memories/recall")) throw new Error("unexpected recall before retain completed");
  return new Response("{}");
};
`,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        preload,
        resolve("scripts/live-curation-smoke.ts"),
      ],
      {
        env: { ...process.env, HOME: root },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /operation .* timed out/);
    assert.doesNotMatch(result.stderr, /unexpected recall/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

for (const script of [
  "benchmark-recall.mjs",
  "export-invalidated.mjs",
  "snapshot-current.mjs",
]) {
  test(`${script} rejects malformed client JSON with file context before contacting Hindsight`, async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-script-json-"));
    try {
      await mkdir(join(root, ".hindsight"));
      const configPath = join(root, ".hindsight", "coding-agent.json");
      await writeFile(configPath, "{invalid");
      const result = spawnSync(
        process.execPath,
        [
          resolve("scripts", script),
          "test",
          join(root, "output.json"),
          join(root, "baseline.json"),
        ],
        {
          env: { ...process.env, HOME: root },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /invalid JSON in .*coding-agent\.json/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("benchmark rejects malformed baseline JSON with file context", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-benchmark-json-"));
  try {
    await mkdir(join(root, ".hindsight"));
    await writeFile(join(root, ".hindsight", "coding-agent.json"), "{}");
    const baselinePath = join(root, "baseline.json");
    await writeFile(baselinePath, "{invalid");
    const result = spawnSync(
      process.execPath,
      [
        resolve("scripts/benchmark-recall.mjs"),
        "test",
        join(root, "output.json"),
        baselinePath,
      ],
      {
        env: { ...process.env, HOME: root },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid JSON in .*baseline\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

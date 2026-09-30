import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathExists } from "../scripts/lib/files.js";
import {
  createOperationWaiter,
  createJsonGetter,
} from "../scripts/lib/hindsight.js";
import { nearestRankPercentile } from "../scripts/lib/statistics.js";

test("operation waiter waits for completion and preserves the operation payload", async () => {
  let clock = 0;
  const statuses = ["PENDING", "PROCESSING", "COMPLETED"];
  const requests: string[][] = [];
  const waiter = createOperationWaiter(
    {
      operationStatus: async (bankId, operationId) => {
        requests.push([bankId, operationId]);
        return { status: statuses.shift() ?? "COMPLETED", marker: "payload" };
      },
    },
    "bank",
    {
      clock: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
      pollIntervalMs: 1,
    },
  );
  assert.deepEqual(await waiter("operation", 10), {
    status: "COMPLETED",
    marker: "payload",
  });
  assert.deepEqual(requests, [
    ["bank", "operation"],
    ["bank", "operation"],
    ["bank", "operation"],
  ]);
});

test("operation waiter rejects cancelled, failed, and still-pending operations", async () => {
  for (const status of ["cancelled", "failed"]) {
    const waiter = createOperationWaiter(
      { operationStatus: async () => ({ status }) },
      "bank",
    );
    await assert.rejects(waiter("operation", 10), new RegExp(status));
  }
  let clock = 0;
  const waiter = createOperationWaiter(
    { operationStatus: async () => ({ status: "processing" }) },
    "bank",
    {
      clock: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
      pollIntervalMs: 1,
    },
  );
  await assert.rejects(waiter("operation", 3), /operation operation timed out/);
});

test("operation waiter preserves acceptance-script error wording", async () => {
  const waiter = createOperationWaiter(
    { operationStatus: async () => ({ status: "FAILED" }) },
    "bank",
    { messageStyle: "status-first" },
  );
  await assert.rejects(waiter("id", 10), /operation failed: id/);
  await assert.rejects(waiter("id", 0), /operation timed out: id/);
});

test("pathExists distinguishes a missing path from other filesystem errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-script-paths-"));
  try {
    const file = join(root, "file");
    await writeFile(file, "content");
    await mkdir(join(root, "directory"));
    assert.equal(await pathExists(file), true);
    assert.equal(await pathExists(join(root, "directory")), true);
    assert.equal(await pathExists(join(root, "missing")), false);
    await assert.rejects(pathExists(join(file, "child")), { code: "ENOTDIR" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nearest-rank percentile preserves empty-input fallback without mutating samples", () => {
  const values = [3, 1, 2, 4];
  assert.equal(nearestRankPercentile(values, 0.5), 2);
  assert.equal(nearestRankPercentile(values, 0.95), 4);
  assert.equal(nearestRankPercentile([], 0.5), 0);
  assert.deepEqual(values, [3, 1, 2, 4]);
});

test("JSON getter forwards authorization and rejects unsuccessful HTTP responses", async (t) => {
  const urls: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: unknown, init?: RequestInit) => {
      urls.push(String(input));
      assert.deepEqual(init?.headers, { Authorization: "fixture" });
      assert.ok(init?.signal);
      return new Response(JSON.stringify({ healthy: true }));
    },
  );
  const get = createJsonGetter<{ healthy: boolean }>("fixture-origin", {
    Authorization: "fixture",
  });
  assert.deepEqual(await get("/health"), { healthy: true });
  assert.deepEqual(urls, ["fixture-origin/health"]);
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("unavailable", { status: 503 }),
  );
  await assert.rejects(get("/health"), /GET \/health: HTTP 503/);
});

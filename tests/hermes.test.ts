import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureHermesScopeStore } from "../src/hermes.js";
import { scope } from "./fixtures.js";

test("Hermes project memory migrates into the stable Scope directory", async () => {
  const agentRoot = await mkdtemp(join(tmpdir(), "hermes-scope-store-"));
  const legacy = join(agentRoot, "projects-memory", "frontend");
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "MEMORY.md"), "first\n§\nsecond\n");
  await writeFile(join(legacy, ".MEMORY.md.recovery-old"), "old snapshot\n");

  const result = await ensureHermesScopeStore(scope, agentRoot);
  assert.equal(result?.name, "product/frontend");
  assert.equal(
    result?.memoryDir,
    join(agentRoot, "projects-memory", scope.scopeId),
  );
  assert.equal(
    await readFile(join(result!.memoryDir, "MEMORY.md"), "utf8"),
    "first\n§\nsecond\n",
  );
  await assert.rejects(access(join(legacy, "MEMORY.md")));
  assert.equal(
    await readFile(
      join(
        result!.memoryDir,
        ".legacy-recovery",
        "frontend",
        ".MEMORY.md.recovery-old",
      ),
      "utf8",
    ),
    "old snapshot\n",
  );
  const metadata = JSON.parse(
    await readFile(
      join(result!.memoryDir, ".pi-memory-scope-store.json"),
      "utf8",
    ),
  );
  assert.equal(metadata.scopeId, scope.scopeId);
  assert.equal(metadata.qualifiedName, "product/frontend");
});

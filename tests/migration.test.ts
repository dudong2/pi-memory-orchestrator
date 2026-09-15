import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { transformArchive } from "../src/migration/transform.js";
import { verifyTransformedArchive } from "../src/migration/verify.js";

async function fixture(): Promise<{ root: string; archive: string }> {
  const root = await mkdtemp(join(tmpdir(), "memory-migration-"));
  const source = join(root, "source");
  await mkdir(join(source, "documents"), { recursive: true });
  await writeFile(
    join(source, "manifest.json"),
    JSON.stringify({
      schema_version: 1,
      source_bank_id: "old-bank",
      document_count: 2,
      fact_count: 2,
      observation_count: 1,
      archive_type: "bank",
    }),
  );
  for (const [index, id] of ["keep", "drop"].entries()) {
    await writeFile(
      join(source, "documents", `${index}.json`),
      JSON.stringify({
        id,
        tags: ["legacy-tag"],
        retain_params: {
          observation_scopes: [["legacy-tag"]],
        },
        facts: [
          {
            text: `${id} fact`,
            tags: ["old"],
            metadata: {},
            observation_scopes: "shared",
            consolidated_at: "2026-09-13T00:00:00.000Z",
          },
        ],
      }),
    );
  }
  await writeFile(join(source, "observations.json"), "[]");
  const archive = join(root, "source.zip");
  execFileSync(
    "zip",
    ["-q", "-r", archive, "manifest.json", "documents", "observations.json"],
    { cwd: source },
  );
  return { root, archive };
}

test("transform selects documents, rewrites scopes, and drops derived bank data", async () => {
  const { root, archive } = await fixture();
  const output = join(root, "output.zip");
  const scopeTag = "scope:repo:github.com/dudong2/test";
  const result = await transformArchive({
    sourceArchive: archive,
    outputArchive: output,
    selectedDocumentIds: ["keep"],
    scopeTag,
  });
  assert.equal(result.documentCount, 1);
  assert.equal(result.factCount, 1);
  const verified = await verifyTransformedArchive(output, scopeTag);
  assert.deepEqual(verified.documentIds, ["keep"]);
  const entries = execFileSync("unzip", ["-Z1", output], { encoding: "utf8" });
  assert.doesNotMatch(entries, /observations\.json/);
  const extracted = join(root, "extracted");
  await mkdir(extracted);
  execFileSync("unzip", ["-q", output, "-d", extracted]);
  const document = JSON.parse(
    await readFile(join(extracted, "documents", "0.json"), "utf8"),
  ) as {
    retain_params?: { observation_scopes?: string[][] };
  };
  assert.deepEqual(document.retain_params?.observation_scopes, [[scopeTag]]);
  assert.notEqual(result.sourceSha256, result.outputSha256);
});

test("transform refuses to overwrite an existing archive", async () => {
  const { root, archive } = await fixture();
  const output = join(root, "output.zip");
  await writeFile(output, "existing");
  await assert.rejects(
    transformArchive({
      sourceArchive: archive,
      outputArchive: output,
      selectedDocumentIds: ["keep"],
      scopeTag: "scope:test",
    }),
    /already exists/,
  );
  assert.equal(await readFile(output, "utf8"), "existing");
});

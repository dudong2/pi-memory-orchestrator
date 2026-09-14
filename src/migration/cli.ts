#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { transformArchive } from "./transform.js";
import { verifyTransformedArchive } from "./verify.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const command = process.argv[2];
if (command === "transform") {
  const sourceArchive = option("source");
  const outputArchive = option("output");
  const scopeTag = option("scope");
  const documentIds = option("documents")?.split(",").map((item) => item.trim()).filter(Boolean);
  if (!sourceArchive || !outputArchive || !scopeTag || !documentIds?.length) {
    throw new Error("transform requires --source, --output, --scope, and comma-separated --documents");
  }
  const result = await transformArchive({ sourceArchive, outputArchive, scopeTag, selectedDocumentIds: documentIds });
  const verification = await verifyTransformedArchive(outputArchive, scopeTag);
  const manifestPath = `${outputArchive}.manifest.json`;
  await writeFile(manifestPath, `${JSON.stringify({ version: 1, createdAt: new Date().toISOString(), result, verification }, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ manifestPath, documentCount: verification.documentCount, factCount: verification.factCount }));
} else if (command === "verify") {
  const archive = option("archive");
  const scopeTag = option("scope");
  if (!archive || !scopeTag) throw new Error("verify requires --archive and --scope");
  console.log(JSON.stringify(await verifyTransformedArchive(archive, scopeTag)));
} else {
  throw new Error("usage: migration <transform|verify> [options]");
}

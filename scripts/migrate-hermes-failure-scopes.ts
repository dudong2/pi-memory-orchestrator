import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveAgentRoot } from "../src/hermes.js";

const projectMap = new Map<string, string | null>([
  ["scratch", null],
  ["LuckyCat", "LuckyCat/LuckyCat"],
  ["certen-io", "certen-io/certen-io"],
  ["ai-chat-engine", "character-ai-chat/ai-chat-engine"],
  ["pi-memory-orchestrator", "pi-memory-orchestrator/pi-memory-orchestrator"],
]);
const path = join(resolveAgentRoot(), "pi-hermes-memory", "failures.md");
const original = await readFile(path, "utf8");
const updated = original.replace(
  /, project64=([A-Za-z0-9_-]+)/g,
  (match, encoded: string) => {
    const oldName = Buffer.from(encoded, "base64url").toString("utf8");
    if (!projectMap.has(oldName)) return match;
    const next = projectMap.get(oldName);
    return next ? `, project64=${Buffer.from(next).toString("base64url")}` : "";
  },
);
if (updated !== original) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, updated, { mode: 0o600 });
  await rename(temporary, path);
}
console.log(JSON.stringify({ changed: updated !== original, path }));

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson } from "../src/json.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(
  homedir(),
  ".pi",
  "agent",
  "npm",
  "node_modules",
  "pi-hermes-memory",
);
const packageJson = parseJson<{ version?: string }>(
  await readFile(join(packageRoot, "package.json"), "utf8"),
  "pi-hermes-memory package.json",
);
if (packageJson.version !== "0.9.9") {
  throw new Error(
    `unsupported pi-hermes-memory version: ${String(packageJson.version)}`,
  );
}
const patchPath = join(
  root,
  "patches",
  "pi-hermes-memory-0.9.9-explicit-scopes.patch",
);
const runPatch = (args: string[]) =>
  execFileSync("patch", ["-p1", "-d", packageRoot, ...args, "-i", patchPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

let status = "already-applied";
try {
  runPatch(["--dry-run", "--forward"]);
  runPatch(["--forward"]);
  status = "applied";
} catch (error) {
  try {
    runPatch(["--dry-run", "--reverse"]);
  } catch {
    throw new Error("pi-hermes-memory scope patch does not apply cleanly", {
      cause: error,
    });
  }
}

const configPath = join(homedir(), ".pi", "agent", "hermes-memory-config.json");
const config = parseJson<Record<string, unknown>>(
  await readFile(configPath, "utf8"),
  "Hermes memory config",
);
config.projectResolutionMode = "external";
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
  mode: 0o600,
});
process.stdout.write(
  `${JSON.stringify({ status, packageRoot, configPath })}\n`,
);

import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedScope } from "./scope/resolver.js";

export const HERMES_PROJECT_RESOLVER_EVENT = "pi-hermes-memory:resolve-project";
export const HERMES_SCOPE_STORE_FILE = ".pi-memory-scope-store.json";

export interface HermesProjectInfo {
  name: string;
  memoryDir: string;
}

export interface HermesProjectResolutionRequest {
  ctx: ExtensionContext;
  respond: (
    result: Promise<HermesProjectInfo | null> | HermesProjectInfo | null,
  ) => void;
}

export function resolveAgentRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  return configured
    ? resolve(configured.replace(/^~(?=$|[\\/])/, homedir()))
    : join(homedir(), ".pi", "agent");
}

export function hermesScopeMemoryDir(
  scopeId: string,
  agentRoot = resolveAgentRoot(),
): string {
  return join(agentRoot, "projects-memory", scopeId);
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

function entries(content: string): string[] {
  const trimmed = content.trim();
  return trimmed ? trimmed.split("\n§\n").filter(Boolean) : [];
}

async function mergeLegacyHermesMemory(
  scope: ResolvedScope,
  memoryDir: string,
  agentRoot: string,
): Promise<void> {
  const target = join(memoryDir, "MEMORY.md");
  let targetEntries: string[] = [];
  try {
    targetEntries = entries(await readFile(target, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const sourcePaths: string[] = [];
  const recoveryPaths: Array<{ source: string; destination: string }> = [];
  for (const legacyName of scope.legacyHermesNames) {
    if (legacyName === scope.scopeId) continue;
    const legacyDir = join(agentRoot, "projects-memory", legacyName);
    const source = join(legacyDir, "MEMORY.md");
    try {
      targetEntries = [
        ...new Set([
          ...targetEntries,
          ...entries(await readFile(source, "utf8")),
        ]),
      ];
      sourcePaths.push(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      for (const name of await readdir(legacyDir)) {
        if (!name.startsWith(".MEMORY.md.recovery-")) continue;
        recoveryPaths.push({
          source: join(legacyDir, name),
          destination: join(memoryDir, ".legacy-recovery", legacyName, name),
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  if (targetEntries.length) {
    await writeAtomic(target, `${targetEntries.join("\n§\n")}\n`);
  }
  for (const source of sourcePaths) {
    try {
      await unlink(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const recovery of recoveryPaths) {
    await mkdir(resolve(recovery.destination, ".."), {
      recursive: true,
      mode: 0o700,
    });
    try {
      await rename(recovery.source, recovery.destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function ensureHermesScopeStore(
  scope: ResolvedScope,
  agentRoot = resolveAgentRoot(),
): Promise<HermesProjectInfo | null> {
  if (!scope.projectId || !scope.projectName) {
    throw new Error(`scope has no project: ${scope.scopeId}`);
  }
  const memoryDir = hermesScopeMemoryDir(scope.scopeId, agentRoot);
  await mkdir(memoryDir, { recursive: true, mode: 0o700 });
  await mergeLegacyHermesMemory(scope, memoryDir, agentRoot);
  const metadata = {
    version: 1,
    scopeId: scope.scopeId,
    scopeName: scope.scopeName,
    projectId: scope.projectId,
    projectName: scope.projectName,
    qualifiedName: `${scope.projectName}/${scope.scopeName}`,
  };
  await writeAtomic(
    join(memoryDir, HERMES_SCOPE_STORE_FILE),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  return { name: metadata.qualifiedName, memoryDir };
}

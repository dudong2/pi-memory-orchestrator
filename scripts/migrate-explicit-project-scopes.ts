import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { HERMES_SCOPE_STORE_FILE, resolveAgentRoot } from "../src/hermes.js";
import { parseJson } from "../src/json.js";
import {
  createProject,
  createScope,
  disableProjectMemory,
} from "../src/scope/catalog.js";

interface MigrationProject {
  projectId: string;
  name: string;
  aliases?: string[];
}

interface MigrationScope {
  root: string;
  projectId?: string;
  scopeId: string;
  name: string;
  aliases?: string[];
  kind: "directory" | "repository" | "global";
  memoryTag: string;
  repositoryId?: string;
  legacyHermesNames?: string[];
  createdAt?: string;
}

interface MigrationPlan {
  version: 1;
  projects: MigrationProject[];
  scopes: MigrationScope[];
  retireMarkers?: string[];
  retireHermesProjects?: string[];
}

function expand(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function backupSqlite(
  source: string,
  destination: string,
): Promise<void> {
  if (!(await exists(source))) return;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  execFileSync("sqlite3", [
    source,
    `.backup '${destination.replaceAll("'", "''")}'`,
  ]);
}

async function writeScopeStoreMetadata(
  agentRoot: string,
  scope: MigrationScope,
  project?: MigrationProject,
): Promise<void> {
  if (scope.kind === "global" || !project) return;
  const dir = join(agentRoot, "projects-memory", scope.scopeId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dir, HERMES_SCOPE_STORE_FILE),
    `${JSON.stringify(
      {
        version: 1,
        scopeId: scope.scopeId,
        scopeName: scope.name,
        projectId: project.projectId,
        projectName: project.name,
        qualifiedName: `${project.name}/${scope.name}`,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

const args = process.argv.slice(2);
const planFlag = args.indexOf("--plan");
const rawPlanPath = planFlag >= 0 ? args[planFlag + 1] : undefined;
if (!rawPlanPath) {
  throw new Error(
    "usage: migrate-explicit-project-scopes.ts --plan <path> [--apply]",
  );
}
const apply = args.includes("--apply");
const planPath = expand(rawPlanPath);
const plan = parseJson<MigrationPlan>(
  await readFile(planPath, "utf8"),
  planPath,
);
if (plan.version !== 1)
  throw new Error(`unsupported migration plan version: ${plan.version}`);

const config = loadConfig();
const agentRoot = resolveAgentRoot();
const timestamp = new Date().toISOString().replaceAll(/[-:.]/g, "");
const backupRoot = join(
  config.dataDir,
  "backups",
  `explicit-project-scopes-${timestamp}`,
);
const summary = {
  plan: planPath,
  backupRoot,
  projects: plan.projects.map((project) => project.name),
  scopes: plan.scopes.map((scope) => scope.name),
  retireMarkers: plan.retireMarkers ?? [],
  retireHermesProjects: plan.retireHermesProjects ?? [],
};

if (!apply) {
  process.stdout.write(
    `${JSON.stringify({ apply: false, ...summary }, null, 2)}\n`,
  );
  process.exit(0);
}

await mkdir(backupRoot, { recursive: true, mode: 0o700 });
await cp(planPath, join(backupRoot, basename(planPath)));
const legacyIndex = join(config.dataDir, "scope-index.json");
if (await exists(legacyIndex))
  await cp(legacyIndex, join(backupRoot, "scope-index.v1.json"));
const projectsMemory = join(agentRoot, "projects-memory");
if (await exists(projectsMemory)) {
  await cp(projectsMemory, join(backupRoot, "projects-memory"), {
    recursive: true,
  });
}
await backupSqlite(
  join(agentRoot, "pi-hermes-memory", "sessions.db"),
  join(backupRoot, "sessions.db"),
);
for (const scope of plan.scopes) {
  const marker = join(expand(scope.root), config.markerName);
  if (await exists(marker)) {
    const destination = join(
      backupRoot,
      "markers",
      scope.scopeId,
      config.markerName,
    );
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await cp(marker, destination);
  }
}
for (const markerValue of plan.retireMarkers ?? []) {
  const marker = expand(markerValue);
  if (await exists(marker)) {
    const destination = join(
      backupRoot,
      "retired-markers",
      basename(dirname(marker)),
      config.markerName,
    );
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await cp(marker, destination);
  }
}

for (const project of plan.projects) {
  await createProject(
    config.dataDir,
    project.name,
    project.aliases,
    project.projectId,
  );
}
const projectMap = new Map(
  plan.projects.map((project) => [project.projectId, project]),
);
for (const scope of plan.scopes) {
  if (scope.kind === "global") {
    await disableProjectMemory(config.dataDir, {
      root: expand(scope.root),
      name: basename(expand(scope.root)),
      ...(scope.repositoryId ? { repositoryId: scope.repositoryId } : {}),
    });
    continue;
  }
  await createScope(config.dataDir, {
    root: expand(scope.root),
    projectId: scope.projectId,
    scopeId: scope.scopeId,
    name: scope.name,
    aliases: scope.aliases,
    kind: scope.kind,
    memoryTag: scope.memoryTag,
    repositoryId: scope.repositoryId,
    legacyHermesNames: scope.legacyHermesNames,
    createdAt: scope.createdAt,
    markerName: config.markerName,
  });
  await writeScopeStoreMetadata(
    agentRoot,
    scope,
    scope.projectId ? projectMap.get(scope.projectId) : undefined,
  );
}

for (const markerValue of plan.retireMarkers ?? []) {
  await rm(expand(markerValue), { force: true });
}
const retiredRoot = join(backupRoot, "retired-hermes-projects");
for (const name of plan.retireHermesProjects ?? []) {
  const source = join(projectsMemory, name);
  if (!(await exists(source))) continue;
  await mkdir(retiredRoot, { recursive: true, mode: 0o700 });
  await rename(source, join(retiredRoot, name));
}
if (await exists(legacyIndex)) await rm(legacyIndex);

await writeFile(
  join(backupRoot, "migration-report.json"),
  `${JSON.stringify({ apply: true, completedAt: new Date().toISOString(), ...summary }, null, 2)}\n`,
  { mode: 0o600 },
);
process.stdout.write(
  `${JSON.stringify({ apply: true, ...summary }, null, 2)}\n`,
);

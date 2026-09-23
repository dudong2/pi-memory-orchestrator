import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export const SCOPE_CATALOG_VERSION = 3 as const;
export const SCOPE_MARKER_VERSION = 2 as const;
export const DEFAULT_CATALOG_NAME = "scope-catalog.json";
export const DEFAULT_MARKER_NAME = ".pi-memory-scope.json";

export interface ProjectRecord {
  projectId: string;
  name: string;
  aliases: string[];
  createdAt: string;
  updatedAt: string;
}

export type RegisteredScopeKind = "directory" | "repository";

export interface ScopeMarker {
  version: typeof SCOPE_MARKER_VERSION;
  scopeId: string;
  projectId?: string;
  scopeName: string;
  kind: RegisteredScopeKind;
  createdAt: string;
  updatedAt: string;
}

export interface ScopeRecord {
  scopeId: string;
  name: string;
  aliases: string[];
  projectId?: string;
  kind: RegisteredScopeKind;
  memoryTag: string;
  markerPath: string;
  paths: string[];
  portableMarkerRoot: string;
  portablePaths: string[];
  repositoryId?: string;
  legacyHermesNames?: string[];
  marker: ScopeMarker;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryDisabledProjectRecord {
  memoryDisabledProjectId: string;
  name: string;
  paths: string[];
  portablePaths: string[];
  repositoryId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScopeCatalog {
  version: typeof SCOPE_CATALOG_VERSION;
  projects: Record<string, ProjectRecord>;
  scopes: Record<string, ScopeRecord>;
  memoryDisabledProjects: Record<string, MemoryDisabledProjectRecord>;
}

interface LegacyScopeRecord extends Omit<ScopeRecord, "kind"> {
  kind: RegisteredScopeKind | "global";
}

interface LegacyScopeCatalog {
  version: 2;
  projects: Record<string, ProjectRecord>;
  scopes: Record<string, LegacyScopeRecord>;
}

export interface DisableProjectMemoryInput {
  root: string;
  name?: string;
  repositoryId?: string;
  homeDir?: string;
}

export interface CreateScopeInput {
  root: string;
  projectId?: string;
  name: string;
  aliases?: string[];
  repositoryId?: string;
  legacyHermesNames?: string[];
  kind?: RegisteredScopeKind;
  scopeId?: string;
  memoryTag?: string;
  createdAt?: string;
  markerName?: string;
  homeDir?: string;
}

function normalizedName(value: string, label: string): string {
  const name = value.trim();
  if (!name) throw new Error(`${label} is required`);
  if (name.includes("/")) throw new Error(`${label} cannot contain /`);
  return name;
}

function normalizedAliases(values: string[] = []): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  );
}

function nameKey(value: string): string {
  return value.normalize("NFC").trim().toLocaleLowerCase("en-US");
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch {
    return resolve(path);
  }
}

function portablePath(path: string): string {
  return path.split(sep).join("/").normalize("NFC");
}

export function portableCatalogPath(path: string, home = homedir()): string {
  const absolute = resolve(path);
  const absoluteHome = resolve(home);
  const homeRelative = relative(absoluteHome, absolute);
  if (homeRelative === "") return "~";
  if (!homeRelative.startsWith("..") && !isAbsolute(homeRelative)) {
    return `~/${portablePath(homeRelative)}`;
  }
  return portablePath(absolute);
}

export function catalogPath(dataDir: string): string {
  return join(dataDir, DEFAULT_CATALOG_NAME);
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
      return async () => {
        await handle.close();
        try {
          await unlink(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > 30_000) {
          await unlink(lockPath);
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline)
        throw new Error(`timed out waiting for lock: ${lockPath}`);
      await new Promise((done) => setTimeout(done, 25));
    }
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

export function parseScopeMarker(input: unknown): ScopeMarker {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("scope marker must be an object");
  }
  const raw = input as Partial<ScopeMarker>;
  if (raw.version !== SCOPE_MARKER_VERSION) {
    throw new Error(`unsupported scope marker version: ${String(raw.version)}`);
  }
  if (typeof raw.scopeId !== "string" || !raw.scopeId.trim())
    throw new Error("scopeId is required");
  const kind = raw.kind;
  if (kind !== "directory" && kind !== "repository") {
    throw new Error("kind must be directory or repository");
  }
  if (typeof raw.projectId !== "string" || !raw.projectId.trim()) {
    throw new Error("projectId is required");
  }
  const scopeName = normalizedName(raw.scopeName ?? "", "scopeName");
  if (
    typeof raw.createdAt !== "string" ||
    Number.isNaN(Date.parse(raw.createdAt))
  ) {
    throw new Error("createdAt must be ISO time");
  }
  if (
    typeof raw.updatedAt !== "string" ||
    Number.isNaN(Date.parse(raw.updatedAt))
  ) {
    throw new Error("updatedAt must be ISO time");
  }
  return {
    version: SCOPE_MARKER_VERSION,
    scopeId: raw.scopeId.trim(),
    ...(raw.projectId ? { projectId: raw.projectId.trim() } : {}),
    scopeName,
    kind,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

export async function readScopeMarker(
  markerPath: string,
): Promise<ScopeMarker> {
  const content = await readFile(markerPath, "utf8");
  try {
    return parseScopeMarker(JSON.parse(content) as unknown);
  } catch (error) {
    throw new Error(`invalid scope marker ${markerPath}: ${String(error)}`, {
      cause: error,
    });
  }
}

export async function loadScopeCatalog(dataDir: string): Promise<ScopeCatalog> {
  const path = catalogPath(dataDir);
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as
      | ScopeCatalog
      | LegacyScopeCatalog;
    if (!raw.projects || !raw.scopes) {
      throw new Error(`invalid scope catalog: ${path}`);
    }
    if (raw.version === 2) {
      const legacyGlobalScopes = Object.values(raw.scopes).filter(
        (scope) => scope.kind === "global",
      );
      const memoryDisabledProjects = Object.fromEntries(
        legacyGlobalScopes.map((scope) => {
          const id = `memory-disabled:${scope.scopeId}`;
          const root = scope.paths[0] ?? dirname(scope.markerPath);
          const record: MemoryDisabledProjectRecord = {
            memoryDisabledProjectId: id,
            name: basename(root) || scope.name,
            paths: [...scope.paths],
            portablePaths: [...scope.portablePaths],
            ...(scope.repositoryId
              ? { repositoryId: scope.repositoryId }
              : {}),
            createdAt: scope.createdAt,
            updatedAt: scope.updatedAt,
          };
          return [id, record];
        }),
      );
      const catalog: ScopeCatalog = {
        version: SCOPE_CATALOG_VERSION,
        projects: raw.projects,
        scopes: Object.fromEntries(
          Object.entries(raw.scopes).filter(
            ([, scope]) => scope.kind !== "global",
          ),
        ) as Record<string, ScopeRecord>,
        memoryDisabledProjects,
      };
      await writeJsonAtomic(path, catalog);
      for (const scope of legacyGlobalScopes) {
        try {
          await unlink(scope.markerPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return catalog;
    }
    if (
      raw.version !== SCOPE_CATALOG_VERSION ||
      !raw.memoryDisabledProjects
    ) {
      throw new Error(`invalid scope catalog: ${path}`);
    }
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        version: SCOPE_CATALOG_VERSION,
        projects: {},
        scopes: {},
        memoryDisabledProjects: {},
      };
    }
    throw error;
  }
}

function matchesMemoryDisabledProject(
  project: MemoryDisabledProjectRecord,
  root: string,
  portableRoot: string,
  repositoryId?: string,
): boolean {
  return (
    (repositoryId !== undefined && project.repositoryId === repositoryId) ||
    project.paths.includes(root) ||
    project.portablePaths.includes(portableRoot)
  );
}

export async function findMemoryDisabledProject(
  dataDir: string,
  root: string,
  repositoryId?: string,
  homeDir = homedir(),
): Promise<MemoryDisabledProjectRecord | null> {
  const catalog = await loadScopeCatalog(dataDir);
  const canonicalRoot = await canonicalPath(root);
  const portableRoot = portableCatalogPath(canonicalRoot, homeDir);
  return (
    Object.values(catalog.memoryDisabledProjects).find((project) =>
      matchesMemoryDisabledProject(
        project,
        canonicalRoot,
        portableRoot,
        repositoryId,
      ),
    ) ?? null
  );
}

export async function disableProjectMemory(
  dataDir: string,
  input: DisableProjectMemoryInput,
): Promise<MemoryDisabledProjectRecord> {
  const path = catalogPath(dataDir);
  const release = await acquireLock(`${path}.lock`);
  try {
    const catalog = await loadScopeCatalog(dataDir);
    const root = await canonicalPath(input.root);
    const home = await canonicalPath(input.homeDir ?? homedir());
    const portableRoot = portableCatalogPath(root, home);
    const existing = Object.values(catalog.memoryDisabledProjects).find(
      (project) =>
        matchesMemoryDisabledProject(
          project,
          root,
          portableRoot,
          input.repositoryId,
        ),
    );
    const now = new Date().toISOString();
    if (existing) {
      const next: MemoryDisabledProjectRecord = {
        ...existing,
        paths: [...new Set([...existing.paths, root])].sort((a, b) =>
          a.localeCompare(b),
        ),
        portablePaths: [
          ...new Set([...existing.portablePaths, portableRoot]),
        ].sort((a, b) => a.localeCompare(b)),
        ...(input.repositoryId
          ? { repositoryId: input.repositoryId }
          : {}),
        updatedAt: now,
      };
      catalog.memoryDisabledProjects[existing.memoryDisabledProjectId] = next;
      await writeJsonAtomic(path, catalog);
      return next;
    }

    const memoryDisabledProjectId = `memory-disabled_${randomUUID()}`;
    const record: MemoryDisabledProjectRecord = {
      memoryDisabledProjectId,
      name: normalizedName(input.name ?? basename(root), "project name"),
      paths: [root],
      portablePaths: [portableRoot],
      ...(input.repositoryId ? { repositoryId: input.repositoryId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    catalog.memoryDisabledProjects[memoryDisabledProjectId] = record;
    await writeJsonAtomic(path, catalog);
    return record;
  } finally {
    await release();
  }
}

export function projectByName(
  catalog: ScopeCatalog,
  name: string,
): ProjectRecord | undefined {
  const wanted = nameKey(name);
  return Object.values(catalog.projects).find((project) =>
    [project.name, ...project.aliases].some(
      (candidate) => nameKey(candidate) === wanted,
    ),
  );
}

export function qualifiedScopeName(
  catalog: ScopeCatalog,
  scope: ScopeRecord,
): string {
  const project = scope.projectId
    ? catalog.projects[scope.projectId]
    : undefined;
  return project ? `${project.name}/${scope.name}` : scope.name;
}

export async function createProject(
  dataDir: string,
  name: string,
  aliases: string[] = [],
  projectId = `project_${randomUUID()}`,
): Promise<ProjectRecord> {
  const path = catalogPath(dataDir);
  const release = await acquireLock(`${path}.lock`);
  try {
    const catalog = await loadScopeCatalog(dataDir);
    const projectName = normalizedName(name, "project name");
    const projectAliases = normalizedAliases(aliases);
    const requestedKeys = new Set(
      [projectName, ...projectAliases].map(nameKey),
    );
    const existing = Object.values(catalog.projects).find((project) =>
      [project.name, ...project.aliases].some((candidate) =>
        requestedKeys.has(nameKey(candidate)),
      ),
    );
    if (existing) return existing;
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      projectId,
      name: projectName,
      aliases: projectAliases,
      createdAt: now,
      updatedAt: now,
    };
    catalog.projects[projectId] = project;
    await writeJsonAtomic(path, catalog);
    return project;
  } finally {
    await release();
  }
}

export async function createScope(
  dataDir: string,
  input: CreateScopeInput,
): Promise<ScopeRecord> {
  const path = catalogPath(dataDir);
  const release = await acquireLock(`${path}.lock`);
  try {
    const catalog = await loadScopeCatalog(dataDir);
    const kind =
      input.kind ?? (input.repositoryId ? "repository" : "directory");
    if (kind !== "directory" && kind !== "repository") {
      throw new Error("kind must be directory or repository");
    }
    const projectId = input.projectId;
    if (!projectId || !catalog.projects[projectId]) {
      throw new Error(`unknown projectId: ${String(projectId)}`);
    }
    const name = normalizedName(input.name, "scope name");
    const duplicate = Object.values(catalog.scopes).find(
      (scope) =>
        scope.projectId === projectId &&
        nameKey(scope.name) === nameKey(name),
    );
    if (duplicate) return duplicate;
    const root = await canonicalPath(input.root);
    const home = await canonicalPath(input.homeDir ?? homedir());
    const markerPath = join(root, input.markerName ?? DEFAULT_MARKER_NAME);
    const scopeId = input.scopeId ?? `scope_${randomUUID()}`;
    const createdAt = input.createdAt ?? new Date().toISOString();
    const marker: ScopeMarker = {
      version: SCOPE_MARKER_VERSION,
      scopeId,
      ...(projectId ? { projectId } : {}),
      scopeName: name,
      kind,
      createdAt,
      updatedAt: createdAt,
    };
    const record: ScopeRecord = {
      scopeId,
      name,
      aliases: normalizedAliases(input.aliases),
      ...(projectId ? { projectId } : {}),
      kind,
      memoryTag: input.memoryTag ?? `scope:id:${scopeId}`,
      markerPath,
      paths: [root],
      portableMarkerRoot: portableCatalogPath(root, home),
      portablePaths: [portableCatalogPath(root, home)],
      ...(input.repositoryId ? { repositoryId: input.repositoryId } : {}),
      ...(input.legacyHermesNames?.length
        ? { legacyHermesNames: normalizedAliases(input.legacyHermesNames) }
        : {}),
      marker,
      createdAt,
      updatedAt: createdAt,
    };
    catalog.scopes[scopeId] = record;
    await writeJsonAtomic(path, catalog);
    await writeJsonAtomic(markerPath, marker);
    return record;
  } finally {
    await release();
  }
}

export async function reassignScopeProject(
  dataDir: string,
  scopeId: string,
  targetProjectId: string,
  updatedAt = new Date().toISOString(),
): Promise<ScopeRecord> {
  const path = catalogPath(dataDir);
  const release = await acquireLock(`${path}.lock`);
  try {
    const catalog = await loadScopeCatalog(dataDir);
    const scope = catalog.scopes[scopeId];
    if (!scope) throw new Error(`unknown scopeId: ${scopeId}`);
    const sourceProjectId = scope.projectId;
    if (!sourceProjectId || !catalog.projects[sourceProjectId]) {
      throw new Error(`Scope '${scope.name}' has no registered source Project`);
    }
    const targetProject = catalog.projects[targetProjectId];
    if (!targetProject)
      throw new Error(`unknown projectId: ${targetProjectId}`);
    if (sourceProjectId === targetProjectId) return scope;

    const duplicate = Object.values(catalog.scopes).find(
      (candidate) =>
        candidate.scopeId !== scopeId &&
        candidate.projectId === targetProjectId &&
        nameKey(candidate.name) === nameKey(scope.name),
    );
    if (duplicate) {
      throw new Error(
        `Project '${targetProject.name}' already has Scope '${scope.name}'`,
      );
    }

    const marker = await readScopeMarker(scope.markerPath);
    if (marker.scopeId !== scopeId || marker.projectId !== sourceProjectId) {
      throw new Error(
        `Scope marker does not match catalog membership: ${scope.markerPath}`,
      );
    }
    const nextMarker: ScopeMarker = {
      ...marker,
      projectId: targetProjectId,
      updatedAt,
    };
    const nextScope: ScopeRecord = {
      ...scope,
      projectId: targetProjectId,
      marker: nextMarker,
      updatedAt,
    };
    const previousCatalog = structuredClone(catalog);
    catalog.scopes[scopeId] = nextScope;
    catalog.projects[sourceProjectId] = {
      ...catalog.projects[sourceProjectId],
      updatedAt,
    };
    catalog.projects[targetProjectId] = {
      ...targetProject,
      updatedAt,
    };

    await writeJsonAtomic(path, catalog);
    try {
      // lazy: two filesystem renames cannot be one atomic commit. A durable
      // transaction journal would remove the brief catalog/marker skew window.
      await writeJsonAtomic(scope.markerPath, nextMarker);
    } catch (error) {
      try {
        await writeJsonAtomic(path, previousCatalog);
      } catch (rollbackError) {
        throw new Error(
          `Scope reassignment failed and catalog rollback also failed: ${String(rollbackError)}`,
          { cause: error },
        );
      }
      throw error;
    }
    return nextScope;
  } finally {
    await release();
  }
}

export async function rebindScopeRepositoryId(
  dataDir: string,
  scopeId: string,
  expectedRepositoryId: string,
  repositoryId: string,
): Promise<ScopeRecord | null> {
  if (!expectedRepositoryId || !repositoryId) return null;
  const path = catalogPath(dataDir);
  const release = await acquireLock(`${path}.lock`);
  try {
    const catalog = await loadScopeCatalog(dataDir);
    const current = catalog.scopes[scopeId];
    if (
      !current ||
      current.kind !== "repository" ||
      current.repositoryId !== expectedRepositoryId
    ) {
      return null;
    }
    if (expectedRepositoryId === repositoryId) return current;
    const conflict = Object.values(catalog.scopes).some(
      (scope) =>
        scope.scopeId !== scopeId && scope.repositoryId === repositoryId,
    );
    if (conflict) return null;
    const next: ScopeRecord = {
      ...current,
      repositoryId,
      updatedAt: new Date().toISOString(),
    };
    catalog.scopes[scopeId] = next;
    await writeJsonAtomic(path, catalog);
    return next;
  } finally {
    await release();
  }
}

export async function promoteScopeRepositoryId(
  dataDir: string,
  scopeId: string,
  expectedLocalRepositoryId: string,
  remoteRepositoryId: string,
): Promise<ScopeRecord | null> {
  if (
    !expectedLocalRepositoryId.startsWith("local/") ||
    remoteRepositoryId.startsWith("local/")
  ) {
    return null;
  }
  return rebindScopeRepositoryId(
    dataDir,
    scopeId,
    expectedLocalRepositoryId,
    remoteRepositoryId,
  );
}

export async function updateScopeLocation(
  dataDir: string,
  scopeId: string,
  markerPath: string,
  observedPath: string,
  homeDir = homedir(),
): Promise<ScopeRecord> {
  const path = catalogPath(dataDir);
  const release = await acquireLock(`${path}.lock`);
  try {
    const catalog = await loadScopeCatalog(dataDir);
    const current = catalog.scopes[scopeId];
    if (!current) throw new Error(`scope is not registered: ${scopeId}`);
    const root = await canonicalPath(dirname(markerPath));
    const observed = await canonicalPath(observedPath);
    const paths = [...new Set([...current.paths, observed, root])].sort(
      (a, b) => a.localeCompare(b),
    );
    const portableMarkerRoot = portableCatalogPath(root, homeDir);
    const unchanged =
      resolve(current.markerPath) === resolve(markerPath) &&
      current.portableMarkerRoot === portableMarkerRoot &&
      paths.length === current.paths.length &&
      paths.every((item, index) => item === current.paths[index]);
    if (unchanged) return current;
    const now = new Date().toISOString();
    const marker = { ...current.marker, updatedAt: now };
    const next: ScopeRecord = {
      ...current,
      markerPath,
      paths,
      portableMarkerRoot,
      portablePaths: paths.map((item) => portableCatalogPath(item, homeDir)),
      marker,
      updatedAt: now,
    };
    catalog.scopes[scopeId] = next;
    await writeJsonAtomic(path, catalog);
    if (marker.updatedAt !== current.marker.updatedAt)
      await writeJsonAtomic(markerPath, marker);
    return next;
  } finally {
    await release();
  }
}

export async function restoreScopeMarker(
  dataDir: string,
  root: string,
  repositoryId?: string,
  homeDir = homedir(),
  markerName = DEFAULT_MARKER_NAME,
): Promise<string | null> {
  const catalog = await loadScopeCatalog(dataDir);
  const canonicalRoot = await canonicalPath(root);
  const portableRoot = portableCatalogPath(canonicalRoot, homeDir);
  const candidates = Object.values(catalog.scopes).filter(
    (scope) =>
      scope.portableMarkerRoot === portableRoot ||
      scope.paths.includes(canonicalRoot) ||
      (repositoryId !== undefined && scope.repositoryId === repositoryId),
  );
  const candidate = candidates.length === 1 ? candidates[0] : undefined;
  if (!candidate) return null;
  const target = join(canonicalRoot, markerName);
  try {
    if ((await stat(target)).isFile()) return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeJsonAtomic(target, candidate.marker);
  return target;
}

export async function removeScope(
  dataDir: string,
  scopeId: string,
): Promise<ScopeRecord | null> {
  const path = catalogPath(dataDir);
  const release = await acquireLock(`${path}.lock`);
  try {
    const catalog = await loadScopeCatalog(dataDir);
    const scope = catalog.scopes[scopeId];
    if (!scope) return null;
    delete catalog.scopes[scopeId];
    await writeJsonAtomic(path, catalog);
    return scope;
  } finally {
    await release();
  }
}

export async function removeProjectIfEmpty(
  dataDir: string,
  projectId: string,
): Promise<ProjectRecord | null> {
  const path = catalogPath(dataDir);
  const release = await acquireLock(`${path}.lock`);
  try {
    const catalog = await loadScopeCatalog(dataDir);
    const project = catalog.projects[projectId];
    if (!project) return null;
    const hasScopes = Object.values(catalog.scopes).some(
      (scope) => scope.projectId === projectId,
    );
    if (hasScopes) return null;
    delete catalog.projects[projectId];
    await writeJsonAtomic(path, catalog);
    return project;
  } finally {
    await release();
  }
}

export async function resolveCatalogRecord(
  dataDir: string,
  marker: ScopeMarker,
): Promise<{
  catalog: ScopeCatalog;
  scope: ScopeRecord;
  project?: ProjectRecord;
}> {
  const catalog = await loadScopeCatalog(dataDir);
  const scope = catalog.scopes[marker.scopeId];
  if (!scope)
    throw new Error(
      `scope marker is not registered in the catalog: ${marker.scopeId}`,
    );
  if (scope.projectId !== marker.projectId || scope.kind !== marker.kind) {
    throw new Error(`scope marker does not match catalog: ${marker.scopeId}`);
  }
  const project = scope.projectId
    ? catalog.projects[scope.projectId]
    : undefined;
  if (!project) throw new Error(`scope project is missing: ${scope.projectId}`);
  return { catalog, scope, ...(project ? { project } : {}) };
}

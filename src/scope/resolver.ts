import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DEFAULT_CONFIG } from "../config.js";
import { resolveGitContext, type GitContext } from "./git.js";
import {
  DEFAULT_MARKER_NAME,
  loadScopeCatalog,
  readScopeMarker,
  resolveCatalogRecord,
  restoreScopeMarker,
  updateScopeLocation,
  type ProjectRecord,
  type ScopeMarker,
  type ScopeRecord,
} from "./catalog.js";

export type ScopeKind = "global" | "directory" | "repository";

export interface ScopeReference {
  scopeId: string;
  scopeName: string;
  qualifiedName: string;
  aliases: string[];
  projectId?: string;
  projectName?: string;
  projectAliases: string[];
  memoryTag: string;
  kind: ScopeKind;
  repositoryId?: string;
}

export interface ScopeLayer {
  root: string;
  markerPath: string;
  marker: ScopeMarker;
  kind: ScopeKind;
  tag: string;
  repositoryId?: string;
}

export interface ResolvedScope {
  workspaceRoot: string;
  markerPath: string;
  marker: ScopeMarker;
  scopeId: string;
  scopeName: string;
  projectId?: string;
  projectName?: string;
  legacyHermesNames: string[];
  workspaceTag: string;
  repositoryId?: string;
  repositoryTag?: string;
  git: GitContext | null;
  scopeTag: string;
  kind: ScopeKind;
  /** Kept empty for compatibility. Explicit projects never inherit filesystem ancestors. */
  ancestors: ScopeLayer[];
  knownRepositoryIds: string[];
  workspaceRepositoryIds: string[];
  knownScopes: ScopeReference[];
  projectScopes: ScopeReference[];
}

export interface ResolveScopeOptions {
  markerName?: string;
  dataDir?: string;
  startCwd?: string;
  homeDir?: string;
}

export class ScopeBoundaryError extends Error {
  constructor(path: string) {
    super(`Filesystem root cannot be used as a memory scope: ${path}`);
    this.name = "ScopeBoundaryError";
  }
}

async function markerExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isFilesystemRoot(path: string): boolean {
  const candidate = resolve(path);
  return dirname(candidate) === candidate;
}

function scopeReference(
  record: ScopeRecord,
  project?: ProjectRecord,
): ScopeReference {
  let qualifiedName = record.name;
  if (record.kind === "global") qualifiedName = "global";
  else if (project) qualifiedName = `${project.name}/${record.name}`;
  return {
    scopeId: record.scopeId,
    scopeName: record.name,
    qualifiedName,
    aliases: [...record.aliases],
    ...(record.projectId ? { projectId: record.projectId } : {}),
    ...(project ? { projectName: project.name } : {}),
    projectAliases: project ? [...project.aliases] : [],
    memoryTag: record.memoryTag,
    kind: record.kind,
    ...(record.repositoryId ? { repositoryId: record.repositoryId } : {}),
  };
}

function isPathWithin(path: string, root: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

export async function resolveScope(
  cwd: string,
  options: ResolveScopeOptions = {},
): Promise<ResolvedScope | null> {
  const markerName = options.markerName ?? DEFAULT_MARKER_NAME;
  const dataDir = options.dataDir ?? DEFAULT_CONFIG.dataDir;
  const home = resolve(options.homeDir ?? homedir());
  const git = resolveGitContext(cwd);
  const workspaceRoot = resolve(git?.mainRoot ?? options.startCwd ?? cwd);
  if (isFilesystemRoot(workspaceRoot))
    throw new ScopeBoundaryError(workspaceRoot);

  let markerPath = join(workspaceRoot, markerName);
  if (!(await markerExists(markerPath))) {
    markerPath =
      (await restoreScopeMarker(
        dataDir,
        workspaceRoot,
        git?.repositoryId,
        home,
        markerName,
      )) ?? markerPath;
  }
  if (!(await markerExists(markerPath))) return null;

  const marker = await readScopeMarker(markerPath);
  const { catalog, scope, project } = await resolveCatalogRecord(
    dataDir,
    marker,
  );
  if (scope.kind === "repository" && git?.repositoryId !== scope.repositoryId)
    return null;
  if (scope.kind === "directory" && !isPathWithin(cwd, workspaceRoot))
    return null;

  const updated = await updateScopeLocation(
    dataDir,
    scope.scopeId,
    markerPath,
    workspaceRoot,
    home,
  );
  const knownScopes = Object.values(catalog.scopes)
    .map((record) =>
      scopeReference(
        record,
        record.projectId ? catalog.projects[record.projectId] : undefined,
      ),
    )
    .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
  const projectScopes = updated.projectId
    ? knownScopes.filter(
        (candidate) => candidate.projectId === updated.projectId,
      )
    : [];
  const knownRepositoryIds = knownScopes.flatMap((candidate) =>
    candidate.repositoryId ? [candidate.repositoryId] : [],
  );
  const workspaceRepositoryIds = projectScopes.flatMap((candidate) =>
    candidate.repositoryId ? [candidate.repositoryId] : [],
  );

  return {
    workspaceRoot,
    markerPath,
    marker: updated.marker,
    scopeId: updated.scopeId,
    scopeName: updated.name,
    ...(updated.projectId ? { projectId: updated.projectId } : {}),
    ...(project ? { projectName: project.name } : {}),
    legacyHermesNames: [...(updated.legacyHermesNames ?? [])],
    workspaceTag: updated.memoryTag,
    ...(updated.repositoryId
      ? { repositoryId: updated.repositoryId, repositoryTag: updated.memoryTag }
      : {}),
    git,
    scopeTag: updated.memoryTag,
    kind: updated.kind,
    ancestors: [],
    knownRepositoryIds,
    workspaceRepositoryIds,
    knownScopes,
    projectScopes,
  };
}

export async function listRegisteredProjects(
  dataDir = DEFAULT_CONFIG.dataDir,
): Promise<ProjectRecord[]> {
  const catalog = await loadScopeCatalog(dataDir);
  return Object.values(catalog.projects).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

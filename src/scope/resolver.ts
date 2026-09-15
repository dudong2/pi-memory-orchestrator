import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_CONFIG } from "../config.js";
import { GLOBAL_SCOPE_TAG } from "./query.js";
import { resolveGitContext, type GitContext } from "./git.js";
import {
  DEFAULT_MARKER_NAME,
  ensureMarker,
  pathWorkspaceId,
  readWorkspaceMarker,
  registerRepository,
  restoreIndexedMarker,
  updateScopeIndex,
  type ScopeIndex,
  type WorkspaceMarker,
} from "./marker.js";

export type ScopeKind = "global" | "workspace" | "repository";

export interface ScopeLayer {
  root: string;
  markerPath: string;
  marker: WorkspaceMarker;
  kind: ScopeKind;
  tag: string;
  repositoryId?: string;
}

export interface ResolvedScope {
  workspaceRoot: string;
  markerPath: string;
  marker: WorkspaceMarker;
  workspaceTag: string;
  repositoryId?: string;
  repositoryTag?: string;
  git: GitContext | null;
  /** The one Hindsight tag owned by the marker at workspaceRoot. */
  scopeTag: string;
  kind: ScopeKind;
  /** Nearest physical ancestor first. Relationships are derived, never persisted. */
  ancestors: ScopeLayer[];
  /** Every repository known to the local catalog, for explicit cross-repository lookup. */
  knownRepositoryIds: string[];
  /** Repositories physically contained by the nearest workspace ancestor. */
  workspaceRepositoryIds: string[];
}

export interface ResolveScopeOptions {
  markerName?: string;
  dataDir?: string;
  startCwd?: string;
  /** Test override for HOME-relative recovery paths. */
  homeDir?: string;
}

export class ScopeBoundaryError extends Error {
  constructor(path: string) {
    super(`Filesystem root cannot be used as a memory workspace: ${path}`);
    this.name = "ScopeBoundaryError";
  }
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch {
    return resolve(path);
  }
}

function isPathWithin(path: string, root: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function isFilesystemRoot(path: string): boolean {
  const candidate = resolve(path);
  return dirname(candidate) === candidate;
}

async function markerExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function excludeLocalMarker(
  git: GitContext,
  markerPath: string,
  markerName: string,
): Promise<void> {
  if (resolve(dirname(markerPath)) !== resolve(git.mainRoot)) return;
  const excludePath = join(git.commonDir, "info", "exclude");
  await mkdir(dirname(excludePath), { recursive: true });
  let content = "";
  try {
    content = await readFile(excludePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const rule = `/${markerName}`;
  if (content.split(/\r?\n/).includes(rule)) return;
  const handle = await open(excludePath, "a", 0o600);
  try {
    await handle.write(`${content && !content.endsWith("\n") ? "\n" : ""}${rule}\n`);
  } finally {
    await handle.close();
  }
}

function scopeLayer(
  root: string,
  markerPath: string,
  marker: WorkspaceMarker,
  git: GitContext | null,
): ScopeLayer {
  if (marker.scope === "global") {
    return { root, markerPath, marker, kind: "global", tag: GLOBAL_SCOPE_TAG };
  }
  if (git && resolve(git.mainRoot) === resolve(root)) {
    return {
      root,
      markerPath,
      marker,
      kind: "repository",
      tag: `scope:repo:${git.repositoryId}`,
      repositoryId: git.repositoryId,
    };
  }
  return {
    root,
    markerPath,
    marker,
    kind: "workspace",
    tag: `scope:workspace:${marker.workspaceId}`,
  };
}

async function ancestorLayers(
  currentRoot: string,
  markerName: string,
): Promise<ScopeLayer[]> {
  const layers: ScopeLayer[] = [];
  let current = dirname(currentRoot);
  while (!isFilesystemRoot(current)) {
    const markerPath = join(current, markerName);
    if (await markerExists(markerPath)) {
      const marker = await readWorkspaceMarker(markerPath);
      layers.push(scopeLayer(current, markerPath, marker, resolveGitContext(current)));
    }
    current = dirname(current);
  }
  return layers;
}

async function readScopeIndex(indexPath: string): Promise<ScopeIndex> {
  try {
    const index = JSON.parse(await readFile(indexPath, "utf8")) as ScopeIndex;
    if (index.version === 1 && index.workspaces && typeof index.workspaces === "object") return index;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { version: 1, workspaces: {} };
}

function catalogRepositories(index: ScopeIndex): string[] {
  return [...new Set(Object.values(index.workspaces).flatMap((entry) => entry.repositories))]
    .sort((a, b) => a.localeCompare(b));
}

function workspaceRepositories(
  index: ScopeIndex,
  root: string | undefined,
  currentRepositoryId: string | undefined,
): string[] {
  const repositories = new Set<string>();
  if (currentRepositoryId) repositories.add(currentRepositoryId);
  if (root) {
    for (const entry of Object.values(index.workspaces)) {
      const markerRoot = dirname(entry.markerPath);
      if (!isPathWithin(markerRoot, root)) continue;
      for (const repository of entry.repositories) repositories.add(repository);
    }
  }
  return [...repositories].sort((a, b) => a.localeCompare(b));
}

export async function resolveScope(
  cwd: string,
  options: ResolveScopeOptions = {},
): Promise<ResolvedScope> {
  const resolvedCwd = await canonicalPath(cwd);
  const markerName = options.markerName ?? DEFAULT_MARKER_NAME;
  const dataDir = options.dataDir ?? DEFAULT_CONFIG.dataDir;
  const home = await canonicalPath(options.homeDir ?? homedir());
  const git = resolveGitContext(resolvedCwd);
  const workspaceRoot = await canonicalPath(git?.mainRoot ?? options.startCwd ?? resolvedCwd);
  if (isFilesystemRoot(workspaceRoot)) throw new ScopeBoundaryError(workspaceRoot);

  const indexPath = join(dataDir, "scope-index.json");
  let markerPath = join(workspaceRoot, markerName);
  if (!(await markerExists(markerPath))) {
    markerPath = await restoreIndexedMarker(
      indexPath,
      workspaceRoot,
      git?.repositoryId,
      home,
      markerName,
    ) ?? markerPath;
  }

  const generatedWorkspaceId = git ? undefined : pathWorkspaceId(workspaceRoot, home);
  let marker = await ensureMarker(markerPath, workspaceRoot, generatedWorkspaceId);
  if (git) {
    marker = await registerRepository(markerPath, git.repositoryId);
    await excludeLocalMarker(git, markerPath, markerName);
  }
  await updateScopeIndex(indexPath, markerPath, marker, workspaceRoot, home);

  const current = scopeLayer(workspaceRoot, markerPath, marker, git);
  const ancestors = await ancestorLayers(workspaceRoot, markerName);
  for (const ancestor of ancestors) {
    await updateScopeIndex(indexPath, ancestor.markerPath, ancestor.marker, ancestor.root, home);
  }
  const index = await readScopeIndex(indexPath);
  const nearestWorkspaceRoot = ancestors.find((layer) => layer.kind === "workspace")?.root;
  const repositoryId = current.repositoryId;
  const repositoryTag = repositoryId ? `scope:repo:${repositoryId}` : undefined;

  return {
    workspaceRoot,
    markerPath,
    marker,
    workspaceTag: `scope:workspace:${marker.workspaceId}`,
    ...(repositoryId ? { repositoryId, repositoryTag } : {}),
    git,
    scopeTag: current.tag,
    kind: current.kind,
    ancestors,
    knownRepositoryIds: catalogRepositories(index),
    workspaceRepositoryIds: workspaceRepositories(index, nearestWorkspaceRoot, repositoryId),
  };
}

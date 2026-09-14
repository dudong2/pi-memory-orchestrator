import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DEFAULT_CONFIG } from "../config.js";
import { resolveGitContext, type GitContext } from "./git.js";
import {
  DEFAULT_MARKER_NAME,
  ensureMarker,
  findIndexedMarker,
  findNearestMarker,
  readWorkspaceMarker,
  registerRepository,
  updateScopeIndex,
  type WorkspaceMarker,
} from "./marker.js";

export interface ResolvedScope {
  workspaceRoot: string;
  markerPath: string;
  marker: WorkspaceMarker;
  workspaceTag: string;
  repositoryId?: string;
  repositoryTag?: string;
  git: GitContext | null;
}

export interface ResolveScopeOptions {
  markerName?: string;
  dataDir?: string;
  startCwd?: string;
  /** Test override for the HOME search and creation boundary. */
  homeDir?: string;
}

export class ScopeBoundaryError extends Error {
  constructor(path: string) {
    super(`Home directory cannot be used as a memory workspace: ${path}`);
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

function isForbiddenWorkspaceRoot(path: string, home: string): boolean {
  const candidate = resolve(path);
  return dirname(candidate) === candidate || isPathWithin(home, candidate);
}

async function excludeLocalMarker(git: GitContext, markerPath: string, markerName: string): Promise<void> {
  if (resolve(dirname(markerPath)) !== resolve(git.mainRoot)) return;
  const excludePath = join(git.commonDir, "info", "exclude");
  await mkdir(dirname(excludePath), { recursive: true });
  let content = "";
  try { content = await readFile(excludePath, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const rule = `/${markerName}`;
  if (content.split(/\r?\n/).includes(rule)) return;
  const handle = await open(excludePath, "a", 0o600);
  try { await handle.write(`${content && !content.endsWith("\n") ? "\n" : ""}${rule}\n`); } finally { await handle.close(); }
}

export async function resolveScope(cwd: string, options: ResolveScopeOptions = {}): Promise<ResolvedScope> {
  const resolvedCwd = await canonicalPath(cwd);
  const markerName = options.markerName ?? DEFAULT_MARKER_NAME;
  const dataDir = options.dataDir ?? DEFAULT_CONFIG.dataDir;
  const home = await canonicalPath(options.homeDir ?? homedir());
  const git = resolveGitContext(resolvedCwd);
  const searchBoundary = isPathWithin(resolvedCwd, home) ? home : undefined;

  let markerPath = await findNearestMarker(resolvedCwd, markerName, searchBoundary);
  if (!markerPath && git && resolve(git.mainRoot) !== resolvedCwd) {
    markerPath = await findNearestMarker(git.mainRoot, markerName, searchBoundary);
  }
  if (!markerPath) {
    const indexed = await findIndexedMarker(join(dataDir, "scope-index.json"), resolvedCwd, git?.repositoryId);
    if (indexed && !isForbiddenWorkspaceRoot(await canonicalPath(dirname(indexed)), home)) {
      try {
        await readWorkspaceMarker(indexed);
        markerPath = indexed;
      } catch {
        // The index is derived state. Ignore a stale or invalid target and create a new marker.
      }
    }
  }

  const workspaceRoot = markerPath
    ? dirname(markerPath)
    : git?.mainRoot ?? await canonicalPath(options.startCwd ?? resolvedCwd);
  if (isForbiddenWorkspaceRoot(workspaceRoot, home)) throw new ScopeBoundaryError(workspaceRoot);
  markerPath ??= join(workspaceRoot, markerName);

  let marker = await ensureMarker(markerPath, workspaceRoot);
  if (git) {
    marker = await registerRepository(markerPath, git.repositoryId);
    await excludeLocalMarker(git, markerPath, markerName);
  }
  await updateScopeIndex(join(dataDir, "scope-index.json"), markerPath, marker, resolvedCwd);

  const result: ResolvedScope = {
    workspaceRoot,
    markerPath,
    marker,
    workspaceTag: `scope:workspace:${marker.workspaceId}`,
    git,
  };
  if (git) {
    result.repositoryId = git.repositoryId;
    result.repositoryTag = `scope:repo:${git.repositoryId}`;
  }
  return result;
}

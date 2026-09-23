import { createHash, randomUUID } from "node:crypto";
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

export const WORKSPACE_MARKER_VERSION = 1 as const;
export const DEFAULT_MARKER_NAME = ".pi-memory-scope.json";

export interface WorkspaceMarker {
  version: typeof WORKSPACE_MARKER_VERSION;
  workspaceId: string;
  displayName: string;
  repositories: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ScopeIndexEntry {
  markerPath: string;
  paths: string[];
  repositories: string[];
  updatedAt: string;
  /** Full local identity snapshot used to rebuild a missing marker on another machine. */
  marker?: WorkspaceMarker;
  /** HOME-relative when possible so a restored index survives a username change. */
  portableMarkerRoot?: string;
  portablePaths?: string[];
}

export interface ScopeIndex {
  version: 1;
  workspaces: Record<string, ScopeIndexEntry>;
}

export function parseWorkspaceMarker(input: unknown): WorkspaceMarker {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("workspace marker must be an object");
  const raw = input as Partial<WorkspaceMarker>;
  if (raw.version !== WORKSPACE_MARKER_VERSION)
    throw new Error(
      `unsupported workspace marker version: ${String(raw.version)}`,
    );
  if (
    typeof raw.workspaceId !== "string" ||
    (!/^ws_[0-9a-f-]{36}$/i.test(raw.workspaceId) &&
      !/^path:[0-9a-f]{64}$/.test(raw.workspaceId))
  ) {
    throw new Error("workspaceId must be a ws_-prefixed UUID or path:<sha256>");
  }
  if (typeof raw.displayName !== "string" || !raw.displayName.trim())
    throw new Error("displayName is required");
  if (
    !Array.isArray(raw.repositories) ||
    raw.repositories.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error("repositories must be an array of non-empty strings");
  }
  if (
    typeof raw.createdAt !== "string" ||
    Number.isNaN(Date.parse(raw.createdAt))
  )
    throw new Error("createdAt must be ISO time");
  if (
    typeof raw.updatedAt !== "string" ||
    Number.isNaN(Date.parse(raw.updatedAt))
  )
    throw new Error("updatedAt must be ISO time");
  return {
    version: WORKSPACE_MARKER_VERSION,
    workspaceId: raw.workspaceId,
    displayName: raw.displayName.trim(),
    repositories: [
      ...new Set(raw.repositories.map((item) => item.trim())),
    ].sort((a, b) => a.localeCompare(b)),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

export async function readWorkspaceMarker(
  markerPath: string,
): Promise<WorkspaceMarker> {
  const content = await readFile(markerPath, "utf8");
  try {
    return parseWorkspaceMarker(JSON.parse(content) as unknown);
  } catch (error) {
    throw new Error(
      `invalid workspace marker ${markerPath}: ${String(error)}`,
      { cause: error },
    );
  }
}

export async function findNearestMarker(
  start: string,
  markerName = DEFAULT_MARKER_NAME,
  stopBefore?: string,
): Promise<string | null> {
  let current = resolve(start);
  const boundary = stopBefore ? resolve(stopBefore) : null;
  while (true) {
    // HOME is a search ceiling, not a workspace. The filesystem root is also
    // deliberately skipped so one marker can never capture every local path.
    if (current === boundary || dirname(current) === current) return null;
    const candidate = join(current, markerName);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    current = dirname(current);
  }
}

function portablePath(path: string): string {
  return path.split(sep).join("/").normalize("NFC");
}

export function portableScopePath(path: string, home = homedir()): string {
  const absolute = resolve(path);
  const absoluteHome = resolve(home);
  const homeRelative = relative(absoluteHome, absolute);
  if (homeRelative === "") return "~";
  if (!homeRelative.startsWith("..") && !isAbsolute(homeRelative)) {
    return `~/${portablePath(homeRelative)}`;
  }
  return portablePath(absolute);
}

export function resolvePortableScopePath(
  path: string,
  home = homedir(),
): string {
  if (path === "~") return resolve(home);
  if (path.startsWith("~/")) return resolve(home, path.slice(2));
  return resolve(path);
}

export function pathWorkspaceId(root: string, home: string): string {
  const absoluteRoot = resolve(root);
  const absoluteHome = resolve(home);
  const relativeRoot = relative(absoluteHome, absoluteRoot);
  const isHomeRelative =
    !isAbsolute(relativeRoot) &&
    relativeRoot !== ".." &&
    !relativeRoot.startsWith(`..${sep}`);
  const identity = isHomeRelative
    ? `home:${portablePath(relativeRoot || ".")}`
    : `absolute:${portablePath(absoluteRoot)}`;
  return `path:${createHash("sha256").update(identity).digest("hex")}`;
}

export function createWorkspaceMarker(
  root: string,
  now = new Date(),
  workspaceId = `ws_${randomUUID()}`,
): WorkspaceMarker {
  const timestamp = now.toISOString();
  return {
    version: WORKSPACE_MARKER_VERSION,
    workspaceId,
    displayName: basename(resolve(root)) || "workspace",
    repositories: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function acquireLock(
  lockPath: string,
  timeoutMs = 5_000,
  staleMs = 30_000,
): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
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
        if (Date.now() - info.mtimeMs > staleMs) {
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

export async function mutateWorkspaceMarker(
  markerPath: string,
  mutation: (current: WorkspaceMarker | null) => WorkspaceMarker,
): Promise<WorkspaceMarker> {
  const release = await acquireLock(`${markerPath}.lock`);
  try {
    let current: WorkspaceMarker | null = null;
    try {
      current = await readWorkspaceMarker(markerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next = parseWorkspaceMarker(mutation(current));
    await writeJsonAtomic(markerPath, next);
    return next;
  } finally {
    await release();
  }
}

export async function ensureMarker(
  markerPath: string,
  root: string,
  workspaceId?: string,
): Promise<WorkspaceMarker> {
  return mutateWorkspaceMarker(
    markerPath,
    (current) =>
      current ?? createWorkspaceMarker(root, new Date(), workspaceId),
  );
}

export async function registerRepository(
  markerPath: string,
  repositoryId: string,
): Promise<WorkspaceMarker> {
  return mutateWorkspaceMarker(markerPath, (current) => {
    if (!current)
      throw new Error(`workspace marker does not exist: ${markerPath}`);
    const repositories = [
      ...new Set([...current.repositories, repositoryId]),
    ].sort((a, b) => a.localeCompare(b));
    return { ...current, repositories, updatedAt: new Date().toISOString() };
  });
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch {
    return resolve(path);
  }
}

export async function findIndexedMarker(
  indexPath: string,
  observedPath: string,
  repositoryId?: string,
): Promise<string | null> {
  let index: ScopeIndex;
  try {
    index = JSON.parse(await readFile(indexPath, "utf8")) as ScopeIndex;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    index.version !== 1 ||
    !index.workspaces ||
    typeof index.workspaces !== "object"
  )
    return null;
  const path = await canonicalPath(observedPath);
  const entries = await Promise.all(
    Object.values(index.workspaces).map(async (entry) => ({
      entry,
      paths: await Promise.all(entry.paths.map(canonicalPath)),
    })),
  );
  const matches = entries.filter(({ entry, paths }) => {
    if (repositoryId && entry.repositories.includes(repositoryId)) return true;
    return paths.some(
      (candidate) => path === candidate || path.startsWith(`${candidate}/`),
    );
  });
  const matchingPathLength = (paths: string[]): number =>
    paths.reduce(
      (longest, candidate) =>
        path === candidate || path.startsWith(`${candidate}/`)
          ? Math.max(longest, candidate.length)
          : longest,
      0,
    );
  matches.sort(
    (a, b) => matchingPathLength(b.paths) - matchingPathLength(a.paths),
  );
  return matches[0]?.entry.markerPath ?? null;
}

export async function restoreIndexedMarker(
  indexPath: string,
  root: string,
  repositoryId?: string,
  home = homedir(),
  markerName = DEFAULT_MARKER_NAME,
): Promise<string | null> {
  let index: ScopeIndex;
  try {
    index = JSON.parse(await readFile(indexPath, "utf8")) as ScopeIndex;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    index.version !== 1 ||
    !index.workspaces ||
    typeof index.workspaces !== "object"
  )
    return null;

  const canonicalRoot = await canonicalPath(root);
  const portableRoot = portableScopePath(canonicalRoot, home);
  const entries = Object.values(index.workspaces).filter(
    (entry) => entry.marker,
  );
  let match = entries.find(
    (entry) =>
      entry.portableMarkerRoot === portableRoot ||
      resolve(dirname(entry.markerPath)) === canonicalRoot,
  );
  if (!match && repositoryId) {
    const repositoryMatches = entries.filter((entry) =>
      entry.repositories.includes(repositoryId),
    );
    const repositoryMatch =
      repositoryMatches.length === 1 ? repositoryMatches[0] : undefined;
    if (repositoryMatch) {
      try {
        await stat(repositoryMatch.markerPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          match = repositoryMatch;
        else throw error;
      }
    }
  }
  if (!match?.marker) return null;

  const target = join(canonicalRoot, markerName);
  try {
    await stat(target);
    return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeJsonAtomic(target, match.marker);
  return target;
}

export async function rebuildMarkersFromScopeIndex(
  indexPath: string,
  options: { homeDir?: string; root?: string; markerName?: string } = {},
): Promise<{ restored: string[]; skipped: string[] }> {
  const home = resolve(options.homeDir ?? homedir());
  const onlyWithin = options.root ? resolve(options.root) : undefined;
  const markerName = options.markerName ?? DEFAULT_MARKER_NAME;
  let index: ScopeIndex;
  try {
    index = JSON.parse(await readFile(indexPath, "utf8")) as ScopeIndex;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { restored: [], skipped: [] };
    throw error;
  }
  const restored: string[] = [];
  const skipped: string[] = [];
  for (const entry of Object.values(index.workspaces)) {
    if (!entry.marker || !entry.portableMarkerRoot) continue;
    const root = resolvePortableScopePath(entry.portableMarkerRoot, home);
    if (
      onlyWithin &&
      root !== onlyWithin &&
      !root.startsWith(`${onlyWithin}${sep}`)
    )
      continue;
    try {
      if (!(await stat(root)).isDirectory()) {
        skipped.push(root);
        continue;
      }
    } catch {
      skipped.push(root);
      continue;
    }
    const target = join(root, markerName);
    try {
      await stat(target);
      skipped.push(target);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeJsonAtomic(target, entry.marker);
    restored.push(target);
  }
  return { restored, skipped };
}

export async function removeWorkspaceFromScopeIndex(
  indexPath: string,
  workspaceId: string,
): Promise<boolean> {
  const release = await acquireLock(`${indexPath}.lock`);
  try {
    let index: ScopeIndex;
    try {
      index = JSON.parse(await readFile(indexPath, "utf8")) as ScopeIndex;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (
      index.version !== 1 ||
      !index.workspaces ||
      typeof index.workspaces !== "object"
    ) {
      throw new Error(`invalid scope index: ${indexPath}`);
    }
    if (!index.workspaces[workspaceId]) return false;
    delete index.workspaces[workspaceId];
    await writeJsonAtomic(indexPath, index);
    return true;
  } finally {
    await release();
  }
}

export async function updateScopeIndex(
  indexPath: string,
  markerPath: string,
  marker: WorkspaceMarker,
  observedPath: string,
  home = homedir(),
): Promise<void> {
  const release = await acquireLock(`${indexPath}.lock`);
  try {
    let index: ScopeIndex = { version: 1, workspaces: {} };
    try {
      const parsed = JSON.parse(
        await readFile(indexPath, "utf8"),
      ) as ScopeIndex;
      if (
        parsed.version === 1 &&
        parsed.workspaces &&
        typeof parsed.workspaces === "object"
      )
        index = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const previous = index.workspaces[marker.workspaceId];
    const canonicalObservedPath = await canonicalPath(observedPath);
    const canonicalMarkerRoot = await canonicalPath(dirname(markerPath));
    const paths = [
      ...new Set([
        ...(previous?.paths ?? []),
        canonicalObservedPath,
        canonicalMarkerRoot,
      ]),
    ].sort((a, b) => a.localeCompare(b));
    index.workspaces[marker.workspaceId] = {
      markerPath,
      paths,
      repositories: [...new Set(marker.repositories)].sort((a, b) =>
        a.localeCompare(b),
      ),
      updatedAt: new Date().toISOString(),
      marker,
      portableMarkerRoot: portableScopePath(canonicalMarkerRoot, home),
      portablePaths: paths.map((path) => portableScopePath(path, home)),
    };
    await writeJsonAtomic(indexPath, index);
  } finally {
    await release();
  }
}

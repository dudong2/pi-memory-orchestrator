import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { canonicalizeGitRemote, resolveGitContext } from "../src/scope/git.js";
import {
  ensureMarker,
  pathWorkspaceId,
  readWorkspaceMarker,
  rebuildMarkersFromScopeIndex,
  registerRepository,
  removeWorkspaceFromScopeIndex,
  updateScopeIndex,
} from "../src/scope/marker.js";
import { resolveScope } from "../src/scope/resolver.js";

async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

test("canonicalizeGitRemote normalizes SSH and HTTPS remotes", () => {
  assert.equal(
    canonicalizeGitRemote("git@github.com:Dudong2/LuckyCat.git"),
    "github.com/dudong2/luckycat",
  );
  assert.equal(
    canonicalizeGitRemote("https://GitHub.com/Dudong2/LuckyCat.git"),
    "github.com/dudong2/luckycat",
  );
  assert.equal(canonicalizeGitRemote("file:///tmp/repo"), undefined);
});

test("each non-Git launch root owns a scope and inherits physical ancestors", async () => {
  const root = await tempRoot("memory-scope-nongit-");
  const child = join(root, "child", "nested");
  const dataDir = join(root, "state");
  await mkdir(child, { recursive: true });
  const parent = await resolveScope(root, { dataDir, startCwd: root });
  const current = await resolveScope(child, { dataDir, startCwd: child });
  assert.notEqual(current.marker.workspaceId, parent.marker.workspaceId);
  assert.equal(
    await realpath(current.markerPath),
    await realpath(join(child, ".pi-memory-scope.json")),
  );
  assert.equal(current.scopeTag, current.workspaceTag);
  assert.deepEqual(
    current.ancestors.map((layer) => layer.marker.workspaceId),
    [parent.marker.workspaceId],
  );
});

test("non-Git workspace IDs survive a HOME username change", async () => {
  const machine = await tempRoot("memory-scope-portable-");
  const firstHome = join(machine, "Users", "dudong2");
  const secondHome = join(machine, "Users", "newname");
  const relativeWorkspace = join("workspace", "notes");
  const firstRoot = join(firstHome, relativeWorkspace);
  const secondRoot = join(secondHome, relativeWorkspace);
  await mkdir(firstRoot, { recursive: true });
  await mkdir(secondRoot, { recursive: true });

  const first = await resolveScope(firstRoot, {
    dataDir: join(machine, "first-state"),
    homeDir: firstHome,
    startCwd: firstRoot,
  });
  const second = await resolveScope(secondRoot, {
    dataDir: join(machine, "second-state"),
    homeDir: secondHome,
    startCwd: secondRoot,
  });

  assert.match(first.marker.workspaceId, /^path:[0-9a-f]{64}$/);
  assert.equal(second.marker.workspaceId, first.marker.workspaceId);
  assert.equal(first.marker.workspaceId, pathWorkspaceId(firstRoot, firstHome));
});

test("a HOME scope is inherited but does not capture a Git repository", async () => {
  const home = await tempRoot("memory-scope-home-boundary-");
  const dataDir = join(home, "state");
  const homeMarkerPath = join(home, ".pi-memory-scope.json");
  const homeMarker = await ensureMarker(homeMarkerPath, home);
  const repository = join(home, "workspace", "repository");
  await mkdir(repository, { recursive: true });
  git(repository, "init", "-q");
  git(
    repository,
    "remote",
    "add",
    "origin",
    "git@github.com:dudong2/home-boundary.git",
  );
  await updateScopeIndex(
    join(dataDir, "scope-index.json"),
    homeMarkerPath,
    homeMarker,
    repository,
  );

  const scope = await resolveScope(repository, {
    dataDir,
    homeDir: home,
  } as Parameters<typeof resolveScope>[1]);
  assert.equal(
    await realpath(dirname(scope.markerPath)),
    await realpath(repository),
  );
  assert.notEqual(scope.marker.workspaceId, homeMarker.workspaceId);
  assert.equal(scope.kind, "repository");
  assert.deepEqual(
    scope.ancestors.map((layer) => layer.marker.workspaceId),
    [homeMarker.workspaceId],
  );
  assert.deepEqual(scope.marker.repositories, [
    "github.com/dudong2/home-boundary",
  ]);
});

test("HOME itself can own a scope", async () => {
  const home = await tempRoot("memory-scope-home-root-");
  const dataDir = join(home, "state");
  const scope = await resolveScope(home, { dataDir, homeDir: home });
  assert.equal(scope.workspaceRoot, await realpath(home));
  assert.equal(
    scope.markerPath,
    join(await realpath(home), ".pi-memory-scope.json"),
  );
  assert.equal(scope.kind, "workspace");
});

test("Git scope uses canonical remote and excludes the local marker", async () => {
  const root = await tempRoot("memory-scope-git-");
  git(root, "init", "-q");
  git(root, "remote", "add", "origin", "git@github.com:Dudong2/Scope-Test.git");
  const scope = await resolveScope(root, { dataDir: join(root, "state") });
  assert.equal(scope.repositoryId, "github.com/dudong2/scope-test");
  assert.deepEqual(scope.marker.repositories, [
    "github.com/dudong2/scope-test",
  ]);
  const exclude = await readFile(join(root, ".git", "info", "exclude"), "utf8");
  assert.match(exclude, /^\/\.pi-memory-scope\.json$/m);
});

test("a global marker is inherited by a nested launch scope", async () => {
  const root = await tempRoot("memory-scope-global-");
  const markerPath = join(root, ".pi-memory-scope.json");
  await writeFile(
    markerPath,
    JSON.stringify({
      version: 1,
      workspaceId: "ws_11111111-1111-4111-8111-111111111111",
      displayName: "scratchpad",
      scope: "global",
      repositories: [],
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
    }),
  );
  const child = join(root, "nested");
  await mkdir(child);

  const scope = await resolveScope(child, { dataDir: join(root, "state") });
  assert.notEqual(await realpath(scope.markerPath), await realpath(markerPath));
  assert.equal(scope.kind, "workspace");
  assert.deepEqual(
    scope.ancestors.map((layer) => layer.tag),
    ["scope:global"],
  );
});

test("child repositories own markers and inherit their nearest parent scope", async () => {
  const root = await tempRoot("memory-scope-parent-");
  const dataDir = join(root, "state");
  const parent = await resolveScope(root, { dataDir });
  const child = join(root, "frontend");
  await mkdir(child);
  git(child, "init", "-q");
  git(
    child,
    "remote",
    "add",
    "origin",
    "https://github.com/dudong2/frontend.git",
  );
  const nested = await resolveScope(child, { dataDir });
  assert.notEqual(nested.marker.workspaceId, parent.marker.workspaceId);
  assert.equal(
    await realpath(nested.markerPath),
    await realpath(join(child, ".pi-memory-scope.json")),
  );
  assert.equal(nested.scopeTag, "scope:repo:github.com/dudong2/frontend");
  assert.deepEqual(
    nested.ancestors.map((layer) => layer.marker.workspaceId),
    [parent.marker.workspaceId],
  );
  assert.deepEqual(nested.marker.repositories, ["github.com/dudong2/frontend"]);
});

test("concurrent repository registration loses no updates", async () => {
  const root = await tempRoot("memory-scope-concurrent-");
  const scope = await resolveScope(root, { dataDir: join(root, "state") });
  const repositories = Array.from(
    { length: 20 },
    (_, index) => `github.com/dudong2/repo-${index}`,
  );
  await Promise.all(
    repositories.map((repo) => registerRepository(scope.markerPath, repo)),
  );
  const marker = await readWorkspaceMarker(scope.markerPath);
  assert.deepEqual(marker.repositories, [...repositories].sort());
});

test("a marker preserves identity across a directory move while hierarchy is recomputed", async () => {
  const root = await tempRoot("memory-scope-move-");
  const firstParent = join(root, "first-parent");
  const secondParent = join(root, "second-parent");
  const original = join(firstParent, "project");
  const moved = join(secondParent, "renamed");
  const dataDir = join(root, "state");
  await mkdir(original, { recursive: true });
  await mkdir(secondParent);
  const firstAncestor = await resolveScope(firstParent, { dataDir });
  const secondAncestor = await resolveScope(secondParent, { dataDir });
  const first = await resolveScope(original, { dataDir });
  await rename(original, moved);
  const second = await resolveScope(moved, { dataDir });
  assert.equal(second.marker.workspaceId, first.marker.workspaceId);
  assert.equal(second.marker.displayName, "renamed");
  assert.deepEqual(
    first.ancestors.map((layer) => layer.marker.workspaceId),
    [firstAncestor.marker.workspaceId],
  );
  assert.deepEqual(
    second.ancestors.map((layer) => layer.marker.workspaceId),
    [secondAncestor.marker.workspaceId],
  );
});

test("scope index restores a missing marker at the same portable path", async () => {
  const home = await tempRoot("memory-scope-restore-");
  const root = join(home, "workspace", "project");
  const dataDir = join(home, "state");
  await mkdir(root, { recursive: true });
  const first = await resolveScope(root, { dataDir, homeDir: home });
  await unlink(first.markerPath);
  const restored = await resolveScope(root, { dataDir, homeDir: home });
  assert.equal(restored.marker.workspaceId, first.marker.workspaceId);
  assert.equal(restored.markerPath, first.markerPath);
});

test("scope index rebuild restores every missing marker under a selected root", async () => {
  const home = await tempRoot("memory-scope-rebuild-");
  const firstRoot = join(home, "workspace", "first");
  const secondRoot = join(home, "workspace", "second");
  const dataDir = join(home, "state");
  await mkdir(firstRoot, { recursive: true });
  await mkdir(secondRoot, { recursive: true });
  const first = await resolveScope(firstRoot, { dataDir, homeDir: home });
  const second = await resolveScope(secondRoot, { dataDir, homeDir: home });
  await unlink(first.markerPath);
  await unlink(second.markerPath);
  const result = await rebuildMarkersFromScopeIndex(
    join(dataDir, "scope-index.json"),
    {
      homeDir: home,
      root: join(home, "workspace"),
    },
  );
  assert.deepEqual(
    (await Promise.all(result.restored.map((path) => realpath(path)))).sort(),
    (
      await Promise.all(
        [first.markerPath, second.markerPath].map((path) => realpath(path)),
      )
    ).sort(),
  );
  assert.equal(
    (await readWorkspaceMarker(first.markerPath)).workspaceId,
    first.marker.workspaceId,
  );
  assert.equal(
    (await readWorkspaceMarker(second.markerPath)).workspaceId,
    second.marker.workspaceId,
  );
});

test("scope-index cleanup removes only the selected workspace", async () => {
  const root = await tempRoot("memory-scope-index-cleanup-");
  const dataDir = join(root, "state");
  const first = await resolveScope(join(root, "first"), { dataDir });
  const second = await resolveScope(join(root, "second"), { dataDir });
  const indexPath = join(dataDir, "scope-index.json");

  assert.equal(
    await removeWorkspaceFromScopeIndex(indexPath, first.marker.workspaceId),
    true,
  );
  assert.equal(
    await removeWorkspaceFromScopeIndex(indexPath, first.marker.workspaceId),
    false,
  );
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    workspaces: Record<string, unknown>;
  };
  assert.equal(index.workspaces[first.marker.workspaceId], undefined);
  assert.ok(index.workspaces[second.marker.workspaceId]);
});

test("linked worktree resolves the main repository identity", async () => {
  const root = await tempRoot("memory-scope-worktree-");
  const main = join(root, "main");
  const linked = join(root, "linked");
  await mkdir(main);
  git(main, "init", "-q");
  git(main, "config", "user.email", "test@example.com");
  git(main, "config", "user.name", "Test");
  git(
    main,
    "remote",
    "add",
    "origin",
    "git@github.com:dudong2/worktree-test.git",
  );
  await writeFile(join(main, "README.md"), "test\n");
  git(main, "add", "README.md");
  git(main, "commit", "-qm", "initial");
  git(main, "worktree", "add", "-q", "-b", "linked-test", linked);

  const mainScope = await resolveScope(main, { dataDir: join(root, "state") });
  const linkedScope = await resolveScope(linked, {
    dataDir: join(root, "state"),
  });
  assert.equal(linkedScope.marker.workspaceId, mainScope.marker.workspaceId);
  assert.equal(linkedScope.repositoryId, mainScope.repositoryId);
  assert.equal(
    resolveGitContext(linked)?.commonDir,
    resolveGitContext(main)?.commonDir,
  );
});

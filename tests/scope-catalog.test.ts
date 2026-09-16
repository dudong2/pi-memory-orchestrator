import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createProject,
  createScope,
  loadScopeCatalog,
  projectByName,
  reassignScopeProject,
  removeScope,
} from "../src/scope/catalog.js";
import { resolveScope } from "../src/scope/resolver.js";

async function tempRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

test("an unregistered location stays memory-disabled and creates no marker", async () => {
  const root = await tempRoot("memory-catalog-unregistered-");
  const dataDir = join(root, "state");
  const scope = await resolveScope(root, { dataDir, startCwd: root });
  assert.equal(scope, null);
  await assert.rejects(access(join(root, ".pi-memory-scope.json")));
});

test("a registered scope resolves through its explicit project", async () => {
  const root = await tempRoot("memory-catalog-registered-");
  const dataDir = join(root, "state");
  const project = await createProject(dataDir, "Product");
  const registered = await createScope(dataDir, {
    root,
    projectId: project.projectId,
    name: "backend",
  });

  const scope = await resolveScope(root, { dataDir, startCwd: root });
  assert.equal(scope?.scopeId, registered.scopeId);
  assert.equal(scope?.scopeName, "backend");
  assert.equal(scope?.projectId, project.projectId);
  assert.equal(scope?.projectName, "Product");
  assert.equal(scope?.scopeTag, registered.memoryTag);
});

test("a child directory does not inherit an ancestor scope", async () => {
  const root = await tempRoot("memory-catalog-no-ancestor-");
  const child = join(root, "child");
  const dataDir = join(root, "state");
  await mkdir(child);
  const project = await createProject(dataDir, "Parent");
  await createScope(dataDir, {
    root,
    projectId: project.projectId,
    name: "parent-scope",
  });

  assert.equal(await resolveScope(child, { dataDir, startCwd: child }), null);
});

test("a Git repository resolves its root marker from nested directories", async () => {
  const root = await tempRoot("memory-catalog-git-");
  const nested = join(root, "src", "nested");
  const dataDir = join(root, "state");
  git(root, "init", "-q");
  git(
    root,
    "remote",
    "add",
    "origin",
    "git@github.com:Dudong2/Catalog-Test.git",
  );
  await mkdir(nested, { recursive: true });
  const project = await createProject(dataDir, "Catalog Test");
  const registered = await createScope(dataDir, {
    root,
    projectId: project.projectId,
    name: "catalog-test",
    repositoryId: "github.com/dudong2/catalog-test",
  });

  const scope = await resolveScope(nested, { dataDir });
  assert.equal(scope?.scopeId, registered.scopeId);
  assert.equal(scope?.repositoryId, "github.com/dudong2/catalog-test");
  assert.equal(scope?.workspaceRoot, await realpath(root));
});

test("moving a marker-bearing non-Git scope preserves identity and updates the catalog path", async () => {
  const parent = await tempRoot("memory-catalog-move-");
  const first = join(parent, "first");
  const second = join(parent, "second");
  const dataDir = join(parent, "state");
  await mkdir(first);
  const project = await createProject(dataDir, "Movable");
  const registered = await createScope(dataDir, {
    root: first,
    projectId: project.projectId,
    name: "scope",
  });
  await rename(first, second);

  const scope = await resolveScope(second, { dataDir, startCwd: second });
  assert.equal(scope?.scopeId, registered.scopeId);
  const catalog = await loadScopeCatalog(dataDir);
  assert.equal(
    catalog.scopes[registered.scopeId]?.paths.at(-1),
    await realpath(second),
  );
});

test("removing a Scope leaves its Project and sibling Scopes intact", async () => {
  const root = await tempRoot("memory-catalog-remove-");
  const dataDir = join(root, "state");
  const project = await createProject(dataDir, "Stable");
  const firstRoot = join(root, "first");
  const secondRoot = join(root, "second");
  await mkdir(firstRoot);
  await mkdir(secondRoot);
  const first = await createScope(dataDir, {
    root: firstRoot,
    projectId: project.projectId,
    name: "first",
  });
  const second = await createScope(dataDir, {
    root: secondRoot,
    projectId: project.projectId,
    name: "second",
  });

  assert.equal(
    (await removeScope(dataDir, first.scopeId))?.scopeId,
    first.scopeId,
  );
  const catalog = await loadScopeCatalog(dataDir);
  assert.ok(catalog.projects[project.projectId]);
  assert.equal(catalog.scopes[first.scopeId], undefined);
  assert.ok(catalog.scopes[second.scopeId]);
});

test("reassigning a Scope preserves its identity and memory tag", async () => {
  const root = await tempRoot("memory-catalog-reassign-");
  const dataDir = join(root, "state");
  const scopeRoot = join(root, "service");
  await mkdir(scopeRoot);
  const source = await createProject(dataDir, "Source");
  const target = await createProject(dataDir, "Target");
  const registered = await createScope(dataDir, {
    root: scopeRoot,
    projectId: source.projectId,
    name: "service",
  });

  const reassigned = await reassignScopeProject(
    dataDir,
    registered.scopeId,
    target.projectId,
    "2026-09-16T12:00:00.000Z",
  );

  assert.equal(reassigned.scopeId, registered.scopeId);
  assert.equal(reassigned.memoryTag, registered.memoryTag);
  assert.equal(reassigned.projectId, target.projectId);
  assert.equal(reassigned.updatedAt, "2026-09-16T12:00:00.000Z");
  const marker = JSON.parse(
    await readFile(join(scopeRoot, ".pi-memory-scope.json"), "utf8"),
  );
  assert.equal(marker.scopeId, registered.scopeId);
  assert.equal(marker.projectId, target.projectId);
  const resolved = await resolveScope(scopeRoot, {
    dataDir,
    startCwd: scopeRoot,
  });
  assert.equal(resolved?.projectName, "Target");
  assert.equal(resolved?.scopeTag, registered.memoryTag);
});

test("reassigning a Scope rejects a duplicate name without changing either file", async () => {
  const root = await tempRoot("memory-catalog-reassign-conflict-");
  const dataDir = join(root, "state");
  const firstRoot = join(root, "first");
  const secondRoot = join(root, "second");
  await mkdir(firstRoot);
  await mkdir(secondRoot);
  const source = await createProject(dataDir, "Source");
  const target = await createProject(dataDir, "Target");
  const first = await createScope(dataDir, {
    root: firstRoot,
    projectId: source.projectId,
    name: "service",
  });
  await createScope(dataDir, {
    root: secondRoot,
    projectId: target.projectId,
    name: "service",
  });
  const markerBefore = await readFile(first.markerPath, "utf8");

  await assert.rejects(
    reassignScopeProject(dataDir, first.scopeId, target.projectId),
    /already has Scope 'service'/,
  );

  const catalog = await loadScopeCatalog(dataDir);
  assert.equal(catalog.scopes[first.scopeId]?.projectId, source.projectId);
  assert.equal(await readFile(first.markerPath, "utf8"), markerBefore);
});

test("reassigning a Scope rolls back the catalog when its marker cannot be written", async () => {
  const root = await tempRoot("memory-catalog-reassign-rollback-");
  const dataDir = join(root, "state");
  const scopeRoot = join(root, "service");
  await mkdir(scopeRoot);
  const source = await createProject(dataDir, "Source");
  const target = await createProject(dataDir, "Target");
  const registered = await createScope(dataDir, {
    root: scopeRoot,
    projectId: source.projectId,
    name: "service",
  });
  await rm(scopeRoot, { recursive: true, force: true });
  await writeFile(scopeRoot, "marker parent is not a directory");

  await assert.rejects(
    reassignScopeProject(dataDir, registered.scopeId, target.projectId),
  );

  const catalog = await loadScopeCatalog(dataDir);
  assert.equal(catalog.scopes[registered.scopeId]?.projectId, source.projectId);
});

test("project lookup is case-insensitive and aliases are explicit", async () => {
  const root = await tempRoot("memory-catalog-project-lookup-");
  const project = await createProject(root, "Stable Labs", ["stablelabs"]);
  const catalog = await loadScopeCatalog(root);
  assert.equal(
    projectByName(catalog, "STABLELABS")?.projectId,
    project.projectId,
  );
  assert.equal(
    projectByName(catalog, "stable labs")?.projectId,
    project.projectId,
  );
  const stored = JSON.parse(
    await readFile(join(root, "scope-catalog.json"), "utf8"),
  );
  assert.equal(stored.version, 2);
});

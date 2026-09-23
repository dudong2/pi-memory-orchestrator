import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  createProject,
  createScope,
  loadScopeCatalog,
} from "../src/scope/catalog.js";
import { onboardScope } from "../src/scope/onboarding.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function context(
  cwd: string,
  choices: string[],
  inputs: string[] = [],
  inputPrompts: string[] = [],
  confirmations: boolean[] = [],
  selectPrompts: string[] = [],
  selectOptions: string[][] = [],
): ExtensionContext {
  return {
    cwd,
    ui: {
      select: async (title: string, options: string[]) => {
        selectPrompts.push(title);
        selectOptions.push(options);
        return choices.shift();
      },
      input: async (title: string) => {
        inputPrompts.push(title);
        return inputs.shift();
      },
      confirm: async () => confirmations.shift() ?? false,
      notify: () => undefined,
    },
  } as unknown as ExtensionContext;
}

test("choosing no memory permanently excludes the Project without creating a Scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-onboarding-none-"));
  const config = { ...DEFAULT_CONFIG, dataDir: join(root, "state") };
  const firstScope = await onboardScope(
    context(root, ["이 Project에서 메모리 사용 안 함"]),
    config,
  );
  assert.equal(firstScope, null);
  await assert.rejects(access(join(root, config.markerName)));
  const catalog = await loadScopeCatalog(config.dataDir);
  assert.equal(Object.values(catalog.memoryDisabledProjects).length, 1);

  const secondSelectOptions: string[][] = [];
  const secondScope = await onboardScope(
    context(root, [], [], [], [], [], secondSelectOptions),
    config,
  );
  assert.equal(secondScope, null);
  assert.deepEqual(secondSelectOptions, []);
});

test("Project selection never offers a global Scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-onboarding-no-global-"));
  const config = { ...DEFAULT_CONFIG, dataDir: join(root, "state") };
  const selectOptions: string[][] = [];

  const scope = await onboardScope(
    context(
      root,
      ["이 Project에서 메모리 사용 안 함"],
      [],
      [],
      [],
      [],
      selectOptions,
    ),
    config,
  );

  assert.equal(scope, null);
  assert.equal(selectOptions[0]?.includes("global"), false);
});

test("choosing an existing Project names the Scope from its directory without prompting", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-onboarding-existing-"));
  const launch = join(root, "service");
  await mkdir(launch);
  const config = { ...DEFAULT_CONFIG, dataDir: join(root, "state") };
  const project = await createProject(config.dataDir, "Product");
  const inputPrompts: string[] = [];
  const scope = await onboardScope(
    context(launch, ["Product"], [], inputPrompts),
    config,
  );
  assert.equal(scope?.projectId, project.projectId);
  assert.equal(scope?.scopeName, "service");
  assert.deepEqual(inputPrompts, []);
  await access(join(launch, config.markerName));
});

test("a renamed repository rebinds the existing Scope without Project onboarding", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-onboarding-rename-"));
  const config = { ...DEFAULT_CONFIG, dataDir: join(root, "state") };
  git(root, "init", "-q");
  git(root, "remote", "add", "origin", "git@github.com:dudong2/before.git");
  const project = await createProject(config.dataDir, "Trading");
  const registered = await createScope(config.dataDir, {
    root,
    projectId: project.projectId,
    name: "signals",
    repositoryId: "github.com/dudong2/before",
  });
  git(
    root,
    "remote",
    "set-url",
    "origin",
    "git@github.com:dudong2/after.git",
  );
  const selectPrompts: string[] = [];

  const scope = await onboardScope(
    context(root, [], [], [], [true], selectPrompts),
    config,
  );

  assert.equal(scope?.scopeId, registered.scopeId);
  assert.equal(scope?.scopeTag, registered.memoryTag);
  assert.equal(scope?.projectId, project.projectId);
  assert.equal(scope?.repositoryId, "github.com/dudong2/after");
  assert.deepEqual(selectPrompts, []);
});

test("declining a repository rebind does not fall through to Project onboarding", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-onboarding-decline-"));
  const config = { ...DEFAULT_CONFIG, dataDir: join(root, "state") };
  git(root, "init", "-q");
  git(root, "remote", "add", "origin", "git@github.com:dudong2/before.git");
  const project = await createProject(config.dataDir, "Trading");
  const registered = await createScope(config.dataDir, {
    root,
    projectId: project.projectId,
    name: "signals",
    repositoryId: "github.com/dudong2/before",
  });
  git(
    root,
    "remote",
    "set-url",
    "origin",
    "git@github.com:dudong2/after.git",
  );
  const selectPrompts: string[] = [];

  const scope = await onboardScope(
    context(root, [], [], [], [false], selectPrompts),
    config,
  );

  assert.equal(scope, null);
  assert.deepEqual(selectPrompts, []);
  const catalog = await loadScopeCatalog(config.dataDir);
  assert.equal(
    catalog.scopes[registered.scopeId]?.repositoryId,
    "github.com/dudong2/before",
  );
});

test("a duplicate directory name prompts for a unique Scope name", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-onboarding-conflict-"));
  const existingRoot = join(root, "existing");
  const launch = join(root, "service");
  await mkdir(existingRoot);
  await mkdir(launch);
  const config = { ...DEFAULT_CONFIG, dataDir: join(root, "state") };
  const project = await createProject(config.dataDir, "Product");
  await createScope(config.dataDir, {
    root: existingRoot,
    projectId: project.projectId,
    name: "service",
  });
  const inputPrompts: string[] = [];

  const scope = await onboardScope(
    context(launch, ["Product"], ["service-2"], inputPrompts),
    config,
  );

  assert.equal(scope?.scopeName, "service-2");
  assert.equal(inputPrompts.length, 1);
  await access(join(launch, config.markerName));
});

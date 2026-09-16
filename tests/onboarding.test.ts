import assert from "node:assert/strict";
import { access, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../src/config.js";
import { createProject } from "../src/scope/catalog.js";
import { onboardScope } from "../src/scope/onboarding.js";

function context(
  cwd: string,
  choices: string[],
  inputs: string[] = [],
): ExtensionContext {
  return {
    cwd,
    ui: {
      select: async () => choices.shift(),
      input: async () => inputs.shift(),
      notify: () => undefined,
    },
  } as unknown as ExtensionContext;
}

test("choosing no memory leaves an unregistered directory untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-onboarding-none-"));
  const config = { ...DEFAULT_CONFIG, dataDir: join(root, "state") };
  const scope = await onboardScope(context(root, ["기억 없이 계속"]), config);
  assert.equal(scope, null);
  await assert.rejects(access(join(root, config.markerName)));
});

test("choosing an existing Project creates exactly one explicit Scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-onboarding-existing-"));
  const launch = join(root, "service");
  await mkdir(launch);
  const config = { ...DEFAULT_CONFIG, dataDir: join(root, "state") };
  const project = await createProject(config.dataDir, "Product");
  const scope = await onboardScope(
    context(launch, ["Product"], ["api"]),
    config,
  );
  assert.equal(scope?.projectId, project.projectId);
  assert.equal(scope?.scopeName, "api");
  await access(join(launch, config.markerName));
});

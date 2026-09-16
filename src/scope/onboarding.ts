import { basename, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OrchestratorConfig } from "../config.js";
import { resolveGitContext } from "./git.js";
import {
  createProject,
  createScope,
  loadScopeCatalog,
  type ProjectRecord,
} from "./catalog.js";
import { resolveScope, type ResolvedScope } from "./resolver.js";

const CREATE_PROJECT = "새 Project 만들기";
const WITHOUT_MEMORY = "기억 없이 계속";

function suggestedName(root: string): string {
  return basename(resolve(root)) || "scope";
}

async function chooseProject(
  ctx: ExtensionContext,
  config: OrchestratorConfig,
  root: string,
): Promise<ProjectRecord | null> {
  const catalog = await loadScopeCatalog(config.dataDir);
  const projects = Object.values(catalog.projects).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const choice = await ctx.ui.select("이 위치의 메모리 Project를 선택하세요", [
    ...projects.map((project) => project.name),
    CREATE_PROJECT,
    WITHOUT_MEMORY,
  ]);
  if (!choice || choice === WITHOUT_MEMORY) return null;
  if (choice !== CREATE_PROJECT) {
    const selected = projects.find((project) => project.name === choice);
    if (selected) return selected;
  }
  const proposed = suggestedName(root);
  const input = await ctx.ui.input("새 Project 이름", proposed);
  if (input === undefined) return null;
  return createProject(config.dataDir, input.trim() || proposed);
}

export async function onboardScope(
  ctx: ExtensionContext,
  config: OrchestratorConfig,
): Promise<ResolvedScope | null> {
  const existing = await resolveScope(ctx.cwd, {
    markerName: config.markerName,
    dataDir: config.dataDir,
    startCwd: ctx.cwd,
  });
  if (existing) return existing;

  const git = resolveGitContext(ctx.cwd);
  const root = resolve(git?.mainRoot ?? ctx.cwd);
  const project = await chooseProject(ctx, config, root);
  if (!project) {
    ctx.ui.notify(
      "이 위치에서는 Hindsight와 Hermes Scope 메모리를 사용하지 않습니다.",
      "info",
    );
    return null;
  }

  const proposedScope = suggestedName(root);
  const scopeInput = await ctx.ui.input("새 Scope 이름", proposedScope);
  if (scopeInput === undefined) {
    ctx.ui.notify("Scope 등록을 취소했습니다. 메모리 없이 계속합니다.", "info");
    return null;
  }
  await createScope(config.dataDir, {
    root,
    projectId: project.projectId,
    name: scopeInput.trim() || proposedScope,
    ...(git?.repositoryId ? { repositoryId: git.repositoryId } : {}),
    markerName: config.markerName,
  });
  return resolveScope(ctx.cwd, {
    markerName: config.markerName,
    dataDir: config.dataDir,
    startCwd: ctx.cwd,
  });
}

import { basename, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OrchestratorConfig } from "../config.js";
import { resolveGitContext } from "./git.js";
import {
  createProject,
  createScope,
  loadScopeCatalog,
  readScopeMarker,
  rebindScopeRepositoryId,
  resolveCatalogRecord,
  type CreateScopeInput,
  type ProjectRecord,
  type ScopeCatalog,
} from "./catalog.js";
import { resolveScope, type ResolvedScope } from "./resolver.js";

const GLOBAL_SCOPE = "global";
const GLOBAL_SCOPE_DISAMBIGUATED = "global (전역 Scope)";
const CREATE_PROJECT = "새 Project 만들기";
const WITHOUT_MEMORY = "기억 없이 계속";

type ProjectChoice =
  | { kind: "global" }
  | { kind: "project"; project: ProjectRecord }
  | null;

function suggestedName(root: string): string {
  return basename(resolve(root)) || "scope";
}

function hasScopeName(
  catalog: ScopeCatalog,
  projectId: string,
  name: string,
): boolean {
  const key = name.trim().toLocaleLowerCase();
  return Object.values(catalog.scopes).some(
    (scope) =>
      scope.projectId === projectId &&
      scope.name.trim().toLocaleLowerCase() === key,
  );
}

function availableScopeName(
  catalog: ScopeCatalog,
  projectId: string,
  base: string,
): string {
  let suffix = 2;
  while (hasScopeName(catalog, projectId, `${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

async function chooseScopeName(
  ctx: ExtensionContext,
  config: OrchestratorConfig,
  project: ProjectRecord,
  root: string,
): Promise<string | null> {
  const inferred = suggestedName(root);
  let catalog = await loadScopeCatalog(config.dataDir);
  if (!hasScopeName(catalog, project.projectId, inferred)) return inferred;

  let proposed = availableScopeName(catalog, project.projectId, inferred);
  while (true) {
    const input = await ctx.ui.input(
      `Scope 이름 '${inferred}'이 이미 있습니다. 다른 이름`,
      proposed,
    );
    if (input === undefined) return null;
    const candidate = input.trim() || proposed;
    catalog = await loadScopeCatalog(config.dataDir);
    if (!hasScopeName(catalog, project.projectId, candidate)) return candidate;
    ctx.ui.notify(`Scope 이름 '${candidate}'도 이미 사용 중입니다.`, "warning");
    proposed = availableScopeName(catalog, project.projectId, inferred);
  }
}

async function recoverRenamedRepository(
  ctx: ExtensionContext,
  config: OrchestratorConfig,
  root: string,
): Promise<{ handled: boolean; scope: ResolvedScope | null }> {
  const git = resolveGitContext(ctx.cwd);
  if (!git || git.repositoryId.startsWith("local/")) {
    return { handled: false, scope: null };
  }

  let registered;
  try {
    const marker = await readScopeMarker(join(root, config.markerName));
    registered = await resolveCatalogRecord(config.dataDir, marker);
  } catch {
    return { handled: false, scope: null };
  }
  const previousRepositoryId = registered.scope.repositoryId;
  if (
    registered.scope.kind !== "repository" ||
    !previousRepositoryId ||
    previousRepositoryId === git.repositoryId
  ) {
    return { handled: false, scope: null };
  }

  const confirmed = await ctx.ui.confirm(
    "저장소 연결 변경 감지",
    [
      `기존: ${previousRepositoryId}`,
      `현재: ${git.repositoryId}`,
      "기존 Scope와 현재 저장소의 연결을 갱신할까요?",
    ].join("\n"),
  );
  if (!confirmed) {
    ctx.ui.notify(
      "저장소 연결 갱신을 취소했습니다. Project를 다시 선택하지 않고 메모리 없이 계속합니다.",
      "warning",
    );
    return { handled: true, scope: null };
  }

  const rebound = await rebindScopeRepositoryId(
    config.dataDir,
    registered.scope.scopeId,
    previousRepositoryId,
    git.repositoryId,
  );
  if (!rebound) {
    ctx.ui.notify(
      "저장소 연결을 갱신하지 못했습니다. 다른 Scope가 현재 저장소 identity를 사용 중인지 확인하세요.",
      "error",
    );
    return { handled: true, scope: null };
  }
  const scope = await resolveScope(ctx.cwd, {
    markerName: config.markerName,
    dataDir: config.dataDir,
    startCwd: ctx.cwd,
  });
  if (!scope) {
    ctx.ui.notify(
      "저장소 연결은 갱신됐지만 Scope를 다시 해석하지 못했습니다.",
      "error",
    );
    return { handled: true, scope: null };
  }
  ctx.ui.notify(
    `저장소 연결을 ${previousRepositoryId} → ${git.repositoryId}로 갱신했습니다.`,
    "info",
  );
  return { handled: true, scope };
}

async function chooseProject(
  ctx: ExtensionContext,
  config: OrchestratorConfig,
  root: string,
): Promise<ProjectChoice> {
  const catalog = await loadScopeCatalog(config.dataDir);
  const projects = Object.values(catalog.projects).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const hasGlobalScope = Object.values(catalog.scopes).some(
    (scope) => scope.kind === "global",
  );
  const globalOption = projects.some(
    (project) => project.name.toLocaleLowerCase() === GLOBAL_SCOPE,
  )
    ? GLOBAL_SCOPE_DISAMBIGUATED
    : GLOBAL_SCOPE;
  const choice = await ctx.ui.select("이 위치의 메모리 Project를 선택하세요", [
    ...(!hasGlobalScope ? [globalOption] : []),
    ...projects.map((project) => project.name),
    CREATE_PROJECT,
    WITHOUT_MEMORY,
  ]);
  if (!choice || choice === WITHOUT_MEMORY) return null;
  if (!hasGlobalScope && choice === globalOption) return { kind: "global" };
  if (choice !== CREATE_PROJECT) {
    const selected = projects.find((project) => project.name === choice);
    if (selected) return { kind: "project", project: selected };
  }
  const proposed = suggestedName(root);
  const input = await ctx.ui.input("새 Project 이름", proposed);
  if (input === undefined) return null;
  return {
    kind: "project",
    project: await createProject(
      config.dataDir,
      input.trim() || proposed,
    ),
  };
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
  const recovery = await recoverRenamedRepository(ctx, config, root);
  if (recovery.handled) return recovery.scope;

  const choice = await chooseProject(ctx, config, root);
  if (!choice) {
    ctx.ui.notify(
      "이 위치에서는 Hindsight와 Hermes Scope 메모리를 사용하지 않습니다.",
      "info",
    );
    return null;
  }

  if (choice.kind === "global") {
    await createScope(config.dataDir, {
      root,
      name: GLOBAL_SCOPE,
      kind: "global",
      markerName: config.markerName,
    });
    const created = await resolveScope(ctx.cwd, {
      markerName: config.markerName,
      dataDir: config.dataDir,
      startCwd: ctx.cwd,
    });
    if (created) return created;
    ctx.ui.notify("global Scope를 등록했지만 다시 해석하지 못했습니다.", "error");
    return null;
  }

  const { project } = choice;
  while (true) {
    const scopeName = await chooseScopeName(ctx, config, project, root);
    if (!scopeName) {
      ctx.ui.notify(
        "Scope 등록을 취소했습니다. 메모리 없이 계속합니다.",
        "info",
      );
      return null;
    }
    const input: CreateScopeInput = {
      root,
      projectId: project.projectId,
      name: scopeName,
      markerName: config.markerName,
    };
    if (git?.repositoryId) input.repositoryId = git.repositoryId;
    await createScope(config.dataDir, input);
    const created = await resolveScope(ctx.cwd, {
      markerName: config.markerName,
      dataDir: config.dataDir,
      startCwd: ctx.cwd,
    });
    if (created) return created;
    ctx.ui.notify(
      `Scope 이름 '${scopeName}'이 동시에 등록됐습니다. 다른 이름을 선택하세요.`,
      "warning",
    );
  }
}

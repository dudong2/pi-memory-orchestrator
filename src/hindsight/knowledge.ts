import type {
  HindsightClient,
  KnowledgeNode,
  KnowledgePageRequest,
} from "./client.js";
import type { ResolvedScope } from "../scope/resolver.js";
import { GLOBAL_SCOPE_TAG } from "../scope/query.js";

export interface KnowledgeApi {
  knowledgeTree(
    bankId: string,
    signal?: AbortSignal,
  ): Promise<{ roots: KnowledgeNode[] }>;
  createKnowledgeFolder(
    bankId: string,
    request: { name: string; parent_id?: string },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  createKnowledgePage(
    bankId: string,
    request: KnowledgePageRequest,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

export interface KnowledgeViewResult {
  createdFolders: number;
  createdPages: number;
}

function nodeId(response: Record<string, unknown>): string {
  if (typeof response.id === "string") return response.id;
  const node = response.node;
  if (
    node &&
    typeof node === "object" &&
    "id" in node &&
    typeof node.id === "string"
  ) {
    return node.id;
  }
  throw new Error("Hindsight knowledge API response has no node id");
}

function findChild(
  nodes: KnowledgeNode[],
  name: string,
  kind: "folder" | "page",
): KnowledgeNode | undefined {
  return nodes.find((node) => node.kind === kind && node.name === name);
}

async function ensureFolder(
  api: KnowledgeApi,
  bankId: string,
  siblings: KnowledgeNode[],
  name: string,
  parentId: string | undefined,
  signal?: AbortSignal,
): Promise<{ id: string; children: KnowledgeNode[]; created: boolean }> {
  const existing = findChild(siblings, name, "folder");
  if (existing)
    return {
      id: existing.id,
      children: existing.children ?? [],
      created: false,
    };
  const response = await api.createKnowledgeFolder(
    bankId,
    { name, ...(parentId ? { parent_id: parentId } : {}) },
    signal,
  );
  return { id: nodeId(response), children: [], created: true };
}

async function ensurePage(
  api: KnowledgeApi,
  bankId: string,
  siblings: KnowledgeNode[],
  request: KnowledgePageRequest,
  signal?: AbortSignal,
): Promise<boolean> {
  if (findChild(siblings, request.name, "page")) return false;
  await api.createKnowledgePage(bankId, request, signal);
  return true;
}

function pageTrigger() {
  return {
    mode: "delta" as const,
    refresh_after_consolidation: true,
    min_refresh_interval_seconds: 3_600,
    fact_types: ["observation" as const],
    tags_match: "all_strict" as const,
    keep_trace: true,
  };
}

export async function ensureKnowledgeViews(
  api: KnowledgeApi | HindsightClient,
  bankId: string,
  scope: ResolvedScope,
  signal?: AbortSignal,
): Promise<KnowledgeViewResult> {
  const tree = await api.knowledgeTree(bankId, signal);
  let createdFolders = 0;
  let createdPages = 0;
  const root = await ensureFolder(
    api,
    bankId,
    tree.roots,
    "Coding Projects",
    undefined,
    signal,
  );
  if (root.created) createdFolders++;

  if (scope.kind === "global") {
    if (
      await ensurePage(
        api,
        bankId,
        root.children,
        {
          name: "Global knowledge",
          source_query:
            "Maintain a concise current overview of reusable general knowledge, conventions, decisions, corrections, and durable lessons shared across every coding scope.",
          parent_id: root.id,
          tags: [GLOBAL_SCOPE_TAG],
          max_tokens: 2_048,
          trigger: pageTrigger(),
        },
        signal,
      )
    )
      createdPages++;
    return { createdFolders, createdPages };
  }

  if (!scope.projectId || !scope.projectName) {
    throw new Error(`scope has no project: ${scope.scopeId}`);
  }
  const project = await ensureFolder(
    api,
    bankId,
    root.children,
    `${scope.projectName} [${scope.projectId}]`,
    root.id,
    signal,
  );
  if (project.created) createdFolders++;
  const scopeFolder = await ensureFolder(
    api,
    bankId,
    project.children,
    `${scope.scopeName} [${scope.scopeId}]`,
    project.id,
    signal,
  );
  if (scopeFolder.created) createdFolders++;
  if (
    await ensurePage(
      api,
      bankId,
      scopeFolder.children,
      {
        name: scope.repositoryId
          ? `Repository: ${scope.repositoryId.split("/").slice(-2).join("/")}`
          : "Scope overview",
        source_query:
          "Maintain a concise current scope overview covering architecture, conventions, decisions, pitfalls, corrections, and active initiatives. Explain temporal changes rather than silently replacing history.",
        parent_id: scopeFolder.id,
        tags: [scope.scopeTag],
        max_tokens: 2_048,
        trigger: pageTrigger(),
      },
      signal,
    )
  )
    createdPages++;

  return { createdFolders, createdPages };
}

import type { TagFilterGroup, TagFilterLeaf } from "../hindsight/client.js";
import type { ResolvedScope } from "./resolver.js";

export const GLOBAL_SCOPE_TAG = "scope:global";

export type ScopeQueryMode = "auto" | "current" | "workspace" | "all" | "repositories";

export interface ScopeQueryOptions {
  mode?: ScopeQueryMode;
  repositoryIds?: string[];
}

export interface ScopeQueryPlan {
  tags: string[];
  tagGroups: TagFilterGroup[];
  expandedRepositories: string[];
  workspaceWide: boolean;
}

const WORKSPACE_WIDE_PATTERNS = [
  /\bcross[- ]?repo\b/i,
  /\bacross (?:all )?(?:repos|repositories)\b/i,
  /\ball (?:repos|repositories)\b/i,
  /\bworkspace[- ]wide\b/i,
  /(?:모든|전체)\s*(?:레포|리포지토리|저장소)/i,
  /(?:레포|리포지토리|저장소)\s*(?:전체|전반)/i,
  /프로젝트\s*전체/i,
];

function repositoryAliases(repositoryId: string): string[] {
  const segments = repositoryId.toLowerCase().split("/").filter(Boolean);
  const repo = segments.at(-1) ?? repositoryId.toLowerCase();
  const ownerRepo = segments.length >= 2 ? segments.slice(-2).join("/") : repo;
  const aliases = [repositoryId.toLowerCase(), ownerRepo, repo];
  return [...new Set(aliases.flatMap((alias) => [
    alias,
    alias.replaceAll("_", "-"),
    alias.replaceAll("-", "_"),
  ]))];
}

function mentionsAlias(query: string, alias: string): boolean {
  const normalized = query.toLowerCase();
  if (alias.includes("/")) return normalized.includes(alias);
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(normalized);
}

export function hasWorkspaceWideIntent(query: string): boolean {
  return WORKSPACE_WIDE_PATTERNS.some((pattern) => pattern.test(query));
}

function leaf(tag: string): TagFilterLeaf {
  return { tags: [tag], match: "all_strict" };
}

export function buildScopeQueryPlan(
  scope: ResolvedScope,
  query: string,
  options: ScopeQueryOptions = {},
): ScopeQueryPlan {
  const mode = options.mode ?? "auto";
  const globalMarker = scope.kind === "global";
  const knownRepositories = globalMarker ? [] : scope.knownRepositoryIds;
  const requested = new Set<string>();
  const workspaceWide = !globalMarker && (mode === "all" || (mode === "auto" && hasWorkspaceWideIntent(query)));

  if (mode === "repositories") {
    const known = new Set(knownRepositories);
    for (const id of options.repositoryIds ?? []) {
      if (known.has(id)) requested.add(id);
    }
  } else if (workspaceWide) {
    for (const id of scope.workspaceRepositoryIds) requested.add(id);
  } else if (mode === "auto") {
    for (const id of knownRepositories) {
      if (id === scope.repositoryId) continue;
      if (repositoryAliases(id).some((alias) => mentionsAlias(query, alias))) requested.add(id);
    }
  }

  const inheritedTags = globalMarker
    ? []
    : scope.ancestors.reduceRight<string[]>((tags, ancestor) => {
      tags.push(ancestor.tag);
      return tags;
    }, []);
  const includeCurrent = !globalMarker && (mode !== "workspace" || scope.kind !== "repository");
  const tags = [
    GLOBAL_SCOPE_TAG,
    ...inheritedTags,
    ...(includeCurrent ? [scope.scopeTag] : []),
    ...[...requested]
      .sort((a, b) => a.localeCompare(b))
      .map((id) => `scope:repo:${id}`),
  ].filter((tag, index, all) => all.indexOf(tag) === index);
  const leaves = tags.map(leaf);

  return {
    tags,
    tagGroups: [{ or: leaves }],
    expandedRepositories: [...requested]
      .filter((id) => id !== scope.repositoryId)
      .sort((a, b) => a.localeCompare(b)),
    workspaceWide,
  };
}

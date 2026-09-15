import type { OrchestratorConfig } from "../config.js";
import { buildScopeQueryPlan, GLOBAL_SCOPE_TAG, type ScopeQueryOptions, type ScopeQueryPlan } from "../scope/query.js";
import type { ResolvedScope } from "../scope/resolver.js";
import { HindsightClient, type RecallMemory, type UpdateMemoryRequest } from "./client.js";
import { ensureKnowledgeViews, type KnowledgeViewResult } from "./knowledge.js";
import { RetainOutbox } from "./outbox.js";

export interface RecallOutcome {
  memories: RecallMemory[];
  plan: ScopeQueryPlan;
  error?: string;
}

export interface TurnIdentity {
  sessionId: string;
  turnId: string;
  harness: "pi" | "omp" | "test";
  timestamp: string;
}

function currentScopeTag(scope: ResolvedScope): string {
  return scope.scopeTag;
}

function workspaceScopeTag(scope: ResolvedScope): string {
  if (scope.kind !== "repository") return scope.scopeTag;
  return scope.ancestors.find((ancestor) => ancestor.kind === "workspace")?.tag ?? scope.scopeTag;
}

export class ScopedHindsightProvider {
  readonly #config: OrchestratorConfig;
  readonly #client: HindsightClient;
  readonly #outbox: RetainOutbox;

  constructor(config: OrchestratorConfig, client: HindsightClient, outbox: RetainOutbox) {
    this.#config = config;
    this.#client = client;
    this.#outbox = outbox;
  }

  bankId(): string {
    return this.#config.mode === "shadow" ? this.#config.shadowBankId : this.#config.bankId;
  }

  async recall(
    query: string,
    scope: ResolvedScope,
    options: ScopeQueryOptions & { signal?: AbortSignal } = {},
  ): Promise<RecallOutcome> {
    const plan = buildScopeQueryPlan(scope, query, options);
    try {
      const response = await this.#client.recall(this.bankId(), {
        query,
        budget: "mid",
        max_tokens: this.#config.maxRecallTokens,
        types: this.#config.recallTypes,
        prefer_observations: this.#config.preferObservations,
        tag_groups: plan.tagGroups,
      }, options.signal);
      return { memories: response.results, plan };
    } catch (error) {
      return {
        memories: [],
        plan,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async enqueueTurn(
    scope: ResolvedScope,
    identity: TurnIdentity,
    user: string,
    assistant: string,
  ): Promise<void> {
    const scopeTag = currentScopeTag(scope);
    await this.#outbox.enqueue({
      identity: `${identity.harness}:${identity.sessionId}:${identity.turnId}`,
      bankId: this.bankId(),
      createdAt: identity.timestamp,
      item: {
        content: JSON.stringify([
          { role: "user", content: user, timestamp: identity.timestamp },
          { role: "assistant", content: assistant, timestamp: identity.timestamp },
        ]),
        timestamp: identity.timestamp,
        context: "conversation between a coding agent and the user",
        document_id: `session-${identity.sessionId}`,
        update_mode: "append",
        tags: [scopeTag],
        observation_scopes: [[scopeTag]],
        metadata: {
          source: "pi-memory-orchestrator",
          harness: identity.harness,
          session_id: identity.sessionId,
          turn_id: identity.turnId,
          workspace_id: scope.marker.workspaceId,
          ...(scope.repositoryId ? { repository: scope.repositoryId } : {}),
        },
      },
    });
  }

  async enqueueExplicit(
    scope: ResolvedScope,
    input: { identity: string; content: string; target: "current" | "workspace"; timestamp?: string },
  ): Promise<void> {
    const scopeTag = input.target === "workspace" ? workspaceScopeTag(scope) : currentScopeTag(scope);
    const timestamp = input.timestamp ?? new Date().toISOString();
    await this.#outbox.enqueue({
      identity: input.identity,
      bankId: this.bankId(),
      createdAt: timestamp,
      item: {
        content: input.content,
        timestamp,
        context: "explicit coding-agent long-term memory",
        document_id: `explicit-${input.identity}`,
        tags: [scopeTag],
        observation_scopes: [[scopeTag]],
        metadata: {
          source: "pi-memory-orchestrator-explicit",
          harness: this.#config.harness,
          workspace_id: scope.marker.workspaceId,
          ...(scope.repositoryId ? { repository: scope.repositoryId } : {}),
        },
      },
    });
  }

  async updateMemory(memoryId: string, request: UpdateMemoryRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.#client.updateMemory(this.bankId(), memoryId, request, signal);
  }

  ensureKnowledgeViews(scope: ResolvedScope, signal?: AbortSignal): Promise<KnowledgeViewResult> {
    return ensureKnowledgeViews(this.#client, this.bankId(), scope, signal);
  }

  async drain(signal?: AbortSignal, maxJobs?: number): Promise<{ completed: number; deferred: number; failed: number }> {
    return this.#outbox.drain(this.#client, { signal, maxJobs });
  }

  counts(): Promise<{ pending: number; processing: number; failed: number }> {
    return this.#outbox.counts();
  }
}

# pi-memory-orchestrator

Shared scoped memory orchestration for Pi and OMP.

## Architecture

- `pi-hermes-memory` injects small bounded `MEMORY.md`, `USER.md`, and current-project working sets.
- This package stores and retrieves long-term knowledge from the local Hindsight PostgreSQL instance.
- OpenRouter receives only recall queries and reranking candidates; the database remains local.
- Pi and OMP use the same Hindsight bank and local durable filesystem outbox.

The active shared bank is `coding-agent::dudong2`. Former `user-knowledge` and per-repository `coding-agent::*` banks are preserved as read-only migration archives.

## Scope

Every Pi or OMP launch root owns a local-only `.pi-memory-scope.json` identity. A Git session materializes its marker at the main repository root even when an ancestor marker exists; a non-Git session materializes one at the launch directory. The marker contains identity metadata only, never memory or secrets.

Hierarchy is derived from the markers' current filesystem positions rather than persisted parent IDs. Moving a marker-bearing directory preserves its identity while recomputing its nearest marked ancestors. A repository session therefore recalls:

```text
global OR marked ancestors (root to leaf) OR current repository
```

Sibling repository details are excluded by default. Naming any repository registered in the central scope catalog adds that repository for the current query; workspace-wide intent adds repositories physically contained by the nearest marked workspace ancestor.

`$HOME` may own and contribute an ordinary ancestor scope when Pi or OMP is launched there. The filesystem root remains forbidden. A marker may instead set `"scope": "global"`; that marker retains and recalls only `scope:global`.

Non-Git IDs use a normalized path hash when first created. Paths below `$HOME` are normalized relative to HOME. The central scope index stores a full marker snapshot plus portable paths, allowing missing markers to be restored lazily during scope resolution or eagerly with the rebuild command. Marker files can likewise rebuild a lost index.

## Lifecycle

- `input`: begin speculative scoped recall.
- `before_agent_start`: inject fenced memory context, failing open on timeout/error.
- `turn_end`: write to the local outbox, then retain asynchronously with an idempotent bank-scoped operation ID.
- `tool_result`: mirror only successful bounded project-memory add/replace operations.
- `session_shutdown`: bounded outbox drain; unfinished writes remain durable for the next process.

## Tools and commands

Active mode registers the `long_memory` tool with `search`, `retain`, `correct`, and `forget` actions. Corrections re-consolidate; forgetting is reversible Hindsight invalidation.

Commands:

- `/memory-orchestrator-status`
- `/memory-orchestrator-recall <query>`
- `/memory-orchestrator-retain [workspace] <content>`
- `/memory-orchestrator-drain`
- `/memory-orchestrator-pages`
- `/memory-orchestrator-rebuild-markers [root]`

## Configuration

Default file: `~/.config/pi-memory-orchestrator/config.json`.

```json
{
  "mode": "active",
  "bankId": "coding-agent::dudong2",
  "shadowBankId": "coding-agent::dudong2::shadow",
  "apiUrl": "http://127.0.0.1:18910",
  "requestTimeoutMs": 30000,
  "targetTimeoutMs": 5000,
  "maxRecallTokens": 4096,
  "recallTypes": ["observation"],
  "preferObservations": false,
  "dataDir": "~/.local/share/pi-memory-orchestrator",
  "markerName": ".pi-memory-scope.json"
}
```

The Hindsight API token is reused from `~/.hindsight/coding-agent.json`; do not duplicate it in this config. `recallTypes` includes raw facts during a migration consolidation backlog. Once the backlog reaches zero, narrow it to `["observation"]` and set `preferObservations` to `false`.

## Verification

```bash
npm run check
npm test
```

Benchmark and migration evidence is retained under:

```text
~/.hindsight/hindsight-backups/pi-memory-orchestrator-20260914T045259Z/
```

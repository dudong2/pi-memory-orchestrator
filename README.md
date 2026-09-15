# pi-memory-orchestrator

Shared scoped memory orchestration for Pi and OMP.

## Architecture

- `pi-hermes-memory` injects small bounded `MEMORY.md`, `USER.md`, and current-project working sets.
- This package stores and retrieves long-term knowledge from the local Hindsight PostgreSQL instance.
- OpenRouter receives only recall queries and reranking candidates; the database remains local.
- Pi and OMP use the same Hindsight bank and local durable filesystem outbox.

The active shared bank is `coding-agent::dudong2`. Former `user-knowledge` and per-repository `coding-agent::*` banks are preserved as read-only migration archives.

## Scope

The nearest local-only `.pi-memory-scope.json` file gives a logical workspace a stable identity. Child Git repositories inherit it; canonical Git remotes identify repository scopes. The marker contains identity metadata only, never memory or secrets. A marker may set `"scope": "global"`; turns retained below that marker use the reserved `scope:global` tag and are visible from every resolved workspace.

`$HOME` and the filesystem root are hard scope boundaries: their markers are neither discovered nor created. A session launched exactly at `$HOME` keeps bounded `pi-hermes-memory` available but disables project-scoped Hindsight recall and retention. When no allowed ancestor marker exists, a Git session creates one at the repository root. A non-Git session creates one at its starting directory with a deterministic `path:<sha256>` workspace ID. Paths below `$HOME` are hashed as normalized home-relative paths, so the ID survives an operating-system username change when the relative directory layout stays the same; paths outside `$HOME` use their normalized absolute path.

Normal recall sends one native Hindsight compound filter for:

```text
global OR current workspace OR current repository
```

A global marker searches only `scope:global`, so it is suitable for a dedicated general-knowledge scratchpad. Ordinary markers omit `scope` (or set it to `"workspace"`).

A query that explicitly names a sibling repository or asks for cross-repository/workspace-wide context expands the filter to the selected child repositories. Global knowledge remains included in every query mode.

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
  "recallTypes": ["observation", "world", "experience"],
  "preferObservations": true,
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

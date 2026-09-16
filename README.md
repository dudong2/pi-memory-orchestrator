# pi-memory-orchestrator

Shared Project/Scope memory orchestration for Pi and OMP.

## Architecture

- `pi-hermes-memory` injects small bounded global and current-Scope working sets.
- This package stores and retrieves long-term knowledge from the local Hindsight PostgreSQL instance.
- OpenRouter receives only recall queries and reranking candidates; the database remains local.
- Pi and OMP use the same catalog, Hindsight bank, Hermes Markdown stores, and durable filesystem outbox.

The active shared bank is `coding-agent::dudong2`. Former `user-knowledge` and per-repository `coding-agent::*` banks remain read-only migration archives.

## Project and Scope model

A Project is a named catalog group. It owns no memory. A Scope belongs to exactly one Project and owns both its Hindsight tag and Hermes working memory. The global Scope is the only special case and belongs to no Project.

The central catalog is:

```text
~/.local/share/pi-memory-orchestrator/scope-catalog.json
```

A registered directory or Git repository carries a local-only `.pi-memory-scope.json` containing stable `projectId`/`scopeId` identity. Paths are recovery addresses, not identity and not parent relationships.

Resolution rules:

- Inside Git, only the repository-root marker is considered.
- Outside Git, only the exact launch-directory marker is considered.
- Filesystem ancestors are never inherited.
- Missing markers are restored only from an unambiguous catalog repository/path match.
- Otherwise the user chooses an existing Project, creates a Project, or continues without memory.
- Continuing without memory creates no marker and disables Hindsight and Hermes Scope reads/writes.

New Project/Scope creation is interactive; users do not need management commands. Moving a marker-bearing directory preserves `scopeId` and updates only catalog paths.

## Recall and retention

Every ordinary write targets only the current Scope. Default recall is:

```text
global OR current Scope
```

Cross-Scope recall is opt-in through an unambiguous natural name or explicit selectors:

```text
project:stablelabs
scope:stablelabs/performance
```

A Project selector expands to all its member Scopes. A Scope selector expands only that Scope.

Hermes Scope Markdown is stored by stable identity:

```text
~/.pi/agent/projects-memory/<scopeId>/MEMORY.md
```

Each directory carries `.pi-memory-scope-store.json` so the SQLite mirror and UI use `Project/Scope` names instead of opaque IDs. Global `MEMORY.md`, `USER.md`, and `failures.md` remain under `~/.pi/agent/pi-hermes-memory/`. Markdown is authoritative; `sessions.db` is the searchable mirror.

## Lifecycle

- `session_start`: resolve or interactively register the current Scope.
- `input`: begin speculative global+Scope recall.
- `before_agent_start`: inject fenced memory context, failing open on timeout/error.
- `turn_end`: retain only under the current Scope through the durable outbox.
- `tool_result`: mirror only successful bounded Scope-memory add/replace operations.
- `session_shutdown`: bounded outbox drain; unfinished writes remain durable for the next process.

## Commands

- `/memory-orchestrator-status`: show current Project/Scope and outbox state.
- `/memory-find <name>`: read-only Project/Scope catalog lookup.

The `long_memory` tool handles scoped search, retention, correction, and forgetting. Retention always uses the current Scope.

## Hermes integration

`pi-hermes-memory@0.9.9` does not natively expose an external Project resolver. This repository carries a narrow, version-checked integration patch that uses Pi's inter-extension event bus while preserving legacy behavior by default:

```bash
node --import tsx scripts/install-pi-hermes-scope-hook.ts
```

The local Hermes config sets `projectResolutionMode` to `external`. If the orchestrator does not answer, Hermes disables Scope memory instead of deriving a directory name. Project skills remain in their existing name-based directories and are not migrated with memory.

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

The Hindsight API token is reused from `~/.hindsight/coding-agent.json`; do not duplicate it in this config.

## Verification

```bash
npm run check
npm test
```

The explicit Project/Scope migration backup is stored under:

```text
~/.local/share/pi-memory-orchestrator/backups/explicit-project-scopes-*/
```

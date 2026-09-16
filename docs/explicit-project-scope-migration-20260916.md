# Explicit Project/Scope migration — 2026-09-16

## Result

The live Pi/OMP memory stack now uses an explicit catalog instead of filesystem ancestry.

- Catalog: `~/.local/share/pi-memory-orchestrator/scope-catalog.json`
- Projects: 8
- Scopes: 14, including the special global Scope
- Hermes Scope stores: `~/.pi/agent/projects-memory/<scopeId>/`
- Hindsight bank: `coding-agent::dudong2`

Projects do not own memory. Each non-global Scope owns one existing Hindsight `memoryTag` and one Hermes Markdown store.

## Migration mapping

- `LuckyCat` → `LuckyCat/LuckyCat`
- `auto-trading` → `auto-trading/auto-trading`
- `automation` → `automation/automation`
- `cancel-ticket` → `cancel-ticket/cancel-ticket`
- `certen-io` → `certen-io/certen-io`
- `ai-chat-engine` → `character-ai-chat/ai-chat-engine`
- `pi-memory-orchestrator` → `pi-memory-orchestrator/pi-memory-orchestrator`
- Stable shared performance memory → `stablelabs/performance`
- Stable repositories → `stablelabs/{stable,stable-bft,stable-evm,stable-geth,stable-sdk}`
- `scratchpad` remains the special global Scope.

Empty parent markers at `LuckyCat/` and `character-ai-chat/` were retired. The old filesystem-derived `scope-index.json` was retired after the v2 catalog and marker files were written.

## Hermes cleanup

The obsolete active project directories `memory`, `pi-improvements`, and `scratch` were moved into the migration backup. Their contents were not deleted without a backup. Live project-memory Markdown was merged into stable Scope-ID directories; name-based directories remain only where they still contain project skills.

Failure-memory project attribution was updated to qualified `Project/Scope` names. `sessions.db` was rebuilt from authoritative Markdown and passed `PRAGMA quick_check`.

## Backup

```text
~/.local/share/pi-memory-orchestrator/backups/explicit-project-scopes-20260916T005726425Z/
```

The backup contains the v1 scope index, old markers, complete `projects-memory`, an SQLite online backup, retired Hermes directories, the migration plan, and the report.

## Hermes integration

`pi-hermes-memory@0.9.9` is patched through the version-checked installer:

```bash
node --import tsx scripts/install-pi-hermes-scope-hook.ts
```

`~/.pi/agent/hermes-memory-config.json` sets `projectResolutionMode` to `external`. Pi and OMP runtime smoke checks both passed. Re-run or update the patch after a future Hermes package version change until the resolver hook is available upstream.

## Verification

```text
npm run check: pass
npm test: 51/51 pass
Pi runtime smoke: OK
OMP runtime smoke: OK
Hermes SQLite quick_check: ok
Default live recall: global + current Scope only
Explicit project:stablelabs recall: all six stablelabs Scopes
Knowledge tree: Coding Projects → Project → Scope
```

# Shadow acceptance — 2026-09-14

## Result

Passed after one audited late-arriving-history repair.

| Check | Result |
|---|---:|
| Captured turns | 51 |
| Temporal correction chains | 10 |
| Scoped recall queries | 100/100 |
| Recall P50 | 118 ms |
| Recall P95 | 176 ms |
| Recall max | 886 ms |
| Outbox pending/processing/failed | 0/0/0 |
| Four-way concurrent recall | Passed |
| Sibling and untagged scope exclusion | Passed |
| OpenRouter 401 fallback to RRF | HTTP 200 in 351 ms |

## Audited correction

The initial run processed one A/B/C document concurrently in the test harness and lost its January fact, yielding 98/100. Production uses one drain per process. Rather than hide the miss, the original report was preserved and the missing January fact was ingested as late-arriving historical evidence. After reconsolidation, both failed queries passed, demonstrating temporal backfill.

A second attempted harness run exposed that Hindsight operation IDs are tenant-wide rather than bank-local. The outbox now derives IDs from `bankId + source identity`; a regression test proves the same source identity produces distinct IDs in primary and shadow banks.

## Evidence

Protected raw report, original report, interrupted-run outbox, and migration artifacts:

`~/.hindsight/hindsight-backups/pi-memory-orchestrator-20260914T045259Z/`

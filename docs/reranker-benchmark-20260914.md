# OpenRouter reranker benchmark — 2026-09-14

## Environment

- Hindsight API: 0.9.2
- Database: local `pg0://hindsight-user-memory`
- Candidate cap: 300
- Recall budget: mid
- Corpus: 5 queries across `coding-agent::LuckyCat` and `user-knowledge`
- Per model: 1 warmup, 15 sequential measured calls, 12 calls in four-way concurrent groups
- Remote timeout: 30 seconds
- Fallback: RRF passthrough

## Baseline

The local `BAAI/bge-reranker-v2-m3` MPS path took 8.9–11.7 seconds for the five baseline queries.

## Results

| Model | P50 | P95 | Max | Mean top-5 overlap with local baseline | Failures |
|---|---:|---:|---:|---:|---:|
| `cohere/rerank-v3.5` | 854 ms | 1,234 ms | 1,444 ms | 68% | 0/27 |
| `cohere/rerank-4-fast` | 897 ms | 1,754 ms | 1,759 ms | 64% | 0/27 |
| `voyageai/rerank-2.5-lite` | 1,038 ms | 1,714 ms | 1,868 ms | 44% | 0/27 |

OpenRouter credit reporting was not used as an exact per-model cost measurement because usage posting can lag and overlap the next measurement window. The raw before/after responses remain in the protected benchmark JSON files.

## Decision

Select `cohere/rerank-v3.5` for the initial production configuration. It had the lowest observed P50/P95, the highest top-5 agreement, no failures, and no concurrency crash.

The main local Hindsight API was restarted with this provider and returned the three post-change smoke queries in 778–940 ms. The local MPS settings remain in `server.env` as rollback values but are inactive.

## Artifacts

Protected raw reports and baseline responses:

`~/.hindsight/hindsight-backups/pi-memory-orchestrator-20260914T045259Z/`

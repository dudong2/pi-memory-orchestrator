import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HindsightClient, RetainItem } from "./client.js";

export interface RetainJob {
  version: 1;
  id: string;
  operationId: string;
  bankId: string;
  item: RetainItem;
  createdAt: string;
  attempts: number;
  nextAttemptAt?: string;
  lastError?: string;
}

export interface OutboxOptions {
  rootDir: string;
  pollIntervalMs?: number;
  operationTimeoutMs?: number;
  staleClaimMs?: number;
  maxAttempts?: number;
  clock?: () => number;
}

export interface DrainResult {
  completed: number;
  deferred: number;
  failed: number;
}

export interface RetainOperations {
  retain(
    bankId: string,
    request: { items: RetainItem[]; async: boolean; operation_id: string },
    signal?: AbortSignal,
  ): Promise<unknown>;
  operationStatus(
    bankId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<{ status: string; error?: unknown }>;
}

export function deterministicOperationId(identity: string): string {
  const bytes = createHash("sha256").update(identity).digest().subarray(0, 16);
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined)
    throw new Error("failed to derive operation UUID");
  bytes[6] = (versionByte & 0x0f) | 0x50;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseJob(content: string, path: string): RetainJob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`invalid outbox JSON ${path}: ${String(error)}`, {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`invalid outbox job ${path}`);
  const job = parsed as Partial<RetainJob>;
  if (
    job.version !== 1 ||
    typeof job.id !== "string" ||
    typeof job.operationId !== "string" ||
    typeof job.bankId !== "string" ||
    !job.item ||
    typeof job.item.content !== "string" ||
    typeof job.createdAt !== "string" ||
    typeof job.attempts !== "number"
  ) {
    throw new Error(`invalid outbox job ${path}`);
  }
  return job as RetainJob;
}

async function writeAtomic(path: string, job: RetainJob): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RetainOutbox {
  readonly #pendingDir: string;
  readonly #processingDir: string;
  readonly #failedDir: string;
  readonly #pollIntervalMs: number;
  readonly #operationTimeoutMs: number;
  readonly #staleClaimMs: number;
  readonly #maxAttempts: number;
  readonly #clock: () => number;

  constructor(options: OutboxOptions) {
    this.#pendingDir = join(options.rootDir, "pending");
    this.#processingDir = join(options.rootDir, "processing");
    this.#failedDir = join(options.rootDir, "failed");
    this.#pollIntervalMs = options.pollIntervalMs ?? 500;
    this.#operationTimeoutMs = options.operationTimeoutMs ?? 30_000;
    this.#staleClaimMs = options.staleClaimMs ?? 120_000;
    this.#maxAttempts = options.maxAttempts ?? 20;
    this.#clock = options.clock ?? Date.now;
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.#pendingDir, { recursive: true, mode: 0o700 }),
      mkdir(this.#processingDir, { recursive: true, mode: 0o700 }),
      mkdir(this.#failedDir, { recursive: true, mode: 0o700 }),
    ]);
    await this.recoverStaleClaims();
  }

  async enqueue(input: {
    identity: string;
    bankId: string;
    item: RetainItem;
    createdAt?: string;
  }): Promise<RetainJob> {
    await this.initialize();
    // Hindsight operation IDs are tenant-wide, not bank-scoped. Include the
    // destination bank so the same turn identity can be replayed into a shadow
    // or migration bank without colliding with the original operation.
    const operationId = deterministicOperationId(
      `${input.bankId}:${input.identity}`,
    );
    const job: RetainJob = {
      version: 1,
      id: operationId,
      operationId,
      bankId: input.bankId,
      item: input.item,
      createdAt: input.createdAt ?? new Date(this.#clock()).toISOString(),
      attempts: 0,
    };
    const path = join(this.#pendingDir, `${job.id}.json`);
    try {
      return parseJob(await readFile(path, "utf8"), path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeAtomic(path, job);
    return job;
  }

  async recoverStaleClaims(): Promise<number> {
    await Promise.all([
      mkdir(this.#pendingDir, { recursive: true, mode: 0o700 }),
      mkdir(this.#processingDir, { recursive: true, mode: 0o700 }),
    ]);
    let recovered = 0;
    for (const name of await readdir(this.#processingDir)) {
      if (!name.endsWith(".json")) continue;
      const source = join(this.#processingDir, name);
      const info = await stat(source);
      if (this.#clock() - info.mtimeMs < this.#staleClaimMs) continue;
      const job = parseJob(await readFile(source, "utf8"), source);
      try {
        await rename(source, join(this.#pendingDir, `${job.id}.json`));
        recovered++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return recovered;
  }

  async drain(
    client: RetainOperations | HindsightClient,
    options: { signal?: AbortSignal; maxJobs?: number } = {},
  ): Promise<DrainResult> {
    await this.initialize();
    const result: DrainResult = { completed: 0, deferred: 0, failed: 0 };
    const names = (await readdir(this.#pendingDir))
      .filter((name) => name.endsWith(".json"))
      .sort((a, b) => a.localeCompare(b));
    for (const name of names.slice(0, options.maxJobs ?? names.length)) {
      if (options.signal?.aborted) break;
      const source = join(this.#pendingDir, name);
      const claimId = `${name.slice(0, -".json".length)}-${process.pid}-${randomUUID()}.json`;
      const claimed = join(this.#processingDir, claimId);
      try {
        // rename preserves an old pending mtime. Refresh it before the claim becomes
        // visible, and use a unique path so stale recovery cannot target a later claim.
        const claimedAt = new Date(this.#clock());
        await utimes(source, claimedAt, claimedAt);
        await rename(source, claimed);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }

      let job: RetainJob;
      try {
        job = parseJob(await readFile(claimed, "utf8"), claimed);
      } catch {
        await rename(claimed, join(this.#failedDir, name));
        result.failed++;
        continue;
      }

      if (job.nextAttemptAt && Date.parse(job.nextAttemptAt) > this.#clock()) {
        await rename(claimed, source);
        result.deferred++;
        continue;
      }

      try {
        await client.retain(
          job.bankId,
          { items: [job.item], async: true, operation_id: job.operationId },
          options.signal,
        );
        await this.#waitForCompletion(client, job, options.signal);
        await unlink(claimed);
        result.completed++;
      } catch (error) {
        job.attempts++;
        job.lastError = errorMessage(error).slice(0, 1_000);
        if (job.attempts >= this.#maxAttempts) {
          await writeAtomic(join(this.#failedDir, name), job);
          await unlink(claimed);
          result.failed++;
        } else {
          const delay = Math.min(
            60_000,
            1_000 * 2 ** Math.min(job.attempts - 1, 6),
          );
          job.nextAttemptAt = new Date(this.#clock() + delay).toISOString();
          await writeAtomic(source, job);
          await unlink(claimed);
          result.deferred++;
        }
      }
    }
    return result;
  }

  async counts(): Promise<{
    pending: number;
    processing: number;
    failed: number;
  }> {
    await this.initialize();
    const count = async (path: string) =>
      (await readdir(path)).filter((name) => name.endsWith(".json")).length;
    const [pending, processing, failed] = await Promise.all([
      count(this.#pendingDir),
      count(this.#processingDir),
      count(this.#failedDir),
    ]);
    return { pending, processing, failed };
  }

  async #waitForCompletion(
    client: RetainOperations | HindsightClient,
    job: RetainJob,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = this.#clock() + this.#operationTimeoutMs;
    while (this.#clock() < deadline) {
      if (signal?.aborted)
        throw signal.reason ?? new Error("outbox drain cancelled");
      const operation = await client.operationStatus(
        job.bankId,
        job.operationId,
        signal,
      );
      const status = operation.status.toLowerCase();
      if (status === "completed") return;
      if (status === "failed" || status === "cancelled") {
        throw new Error(
          `Hindsight operation ${status}: ${JSON.stringify(operation.error ?? "unknown")}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, this.#pollIntervalMs));
    }
    throw new Error(
      `Hindsight operation timed out after ${this.#operationTimeoutMs}ms`,
    );
  }
}

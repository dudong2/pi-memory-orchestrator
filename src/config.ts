import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type OrchestratorMode = "shadow" | "active";

export interface OrchestratorConfig {
  mode: OrchestratorMode;
  harness: "pi" | "omp";
  apiUrl: string;
  apiToken?: string;
  hindsightConfigPath: string;
  bankId: string;
  shadowBankId: string;
  requestTimeoutMs: number;
  targetTimeoutMs: number;
  maxRecallTokens: number;
  recallTypes: Array<"world" | "experience" | "observation">;
  preferObservations: boolean;
  dataDir: string;
  markerName: string;
}

export const DEFAULT_CONFIG_PATH = join(
  homedir(),
  ".config",
  "pi-memory-orchestrator",
  "config.json",
);

function detectHarness(): "pi" | "omp" {
  const explicit = process.env.PI_MEMORY_ORCHESTRATOR_HARNESS;
  if (explicit === "pi" || explicit === "omp") return explicit;
  return process.argv.some((value) => /(^|[\\/])omp(?:\.exe)?$/i.test(value))
    ? "omp"
    : "pi";
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
  mode: "shadow",
  harness: detectHarness(),
  apiUrl: "http://127.0.0.1:8888",
  hindsightConfigPath: join(homedir(), ".hindsight", "coding-agent.json"),
  bankId: "pi",
  shadowBankId: "pi::shadow",
  requestTimeoutMs: 30_000,
  targetTimeoutMs: 5_000,
  maxRecallTokens: 4_096,
  recallTypes: ["observation"],
  preferObservations: false,
  dataDir: join(homedir(), ".local", "share", "pi-memory-orchestrator"),
  markerName: ".pi-memory-scope.json",
};

function positiveInteger(
  value: unknown,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function parseConfig(input: unknown): OrchestratorConfig {
  if (input === undefined || input === null) return { ...DEFAULT_CONFIG };
  if (typeof input !== "object" || Array.isArray(input))
    throw new Error("config must be an object");
  const raw = input as Partial<OrchestratorConfig>;
  const mode = raw.mode ?? DEFAULT_CONFIG.mode;
  if (mode !== "shadow" && mode !== "active")
    throw new Error("mode must be shadow or active");
  const harness = raw.harness ?? DEFAULT_CONFIG.harness;
  if (harness !== "pi" && harness !== "omp")
    throw new Error("harness must be pi or omp");
  const recallTypes = raw.recallTypes ?? DEFAULT_CONFIG.recallTypes;
  const allowedTypes = new Set(["world", "experience", "observation"]);
  if (
    !Array.isArray(recallTypes) ||
    recallTypes.length === 0 ||
    recallTypes.some((type) => !allowedTypes.has(type))
  ) {
    throw new Error(
      "recallTypes must contain world, experience, or observation",
    );
  }
  if (
    raw.preferObservations !== undefined &&
    typeof raw.preferObservations !== "boolean"
  ) {
    throw new Error("preferObservations must be boolean");
  }

  return {
    ...DEFAULT_CONFIG,
    ...raw,
    mode,
    harness,
    recallTypes: [...new Set(recallTypes)],
    preferObservations:
      raw.preferObservations ?? DEFAULT_CONFIG.preferObservations,
    requestTimeoutMs: positiveInteger(
      raw.requestTimeoutMs,
      DEFAULT_CONFIG.requestTimeoutMs,
      "requestTimeoutMs",
    ),
    targetTimeoutMs: positiveInteger(
      raw.targetTimeoutMs,
      DEFAULT_CONFIG.targetTimeoutMs,
      "targetTimeoutMs",
    ),
    maxRecallTokens: positiveInteger(
      raw.maxRecallTokens,
      DEFAULT_CONFIG.maxRecallTokens,
      "maxRecallTokens",
    ),
  };
}

export function loadConfig(
  path = process.env.PI_MEMORY_ORCHESTRATOR_CONFIG || DEFAULT_CONFIG_PATH,
): OrchestratorConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const config = parseConfig(parsed);
    const harness = detectHarness();
    return harness === "omp" ? { ...config, harness } : config;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      return { ...DEFAULT_CONFIG, harness: detectHarness() };
    throw error;
  }
}

export function resolveHindsightConnection(config: OrchestratorConfig): {
  apiUrl: string;
  apiToken?: string;
} {
  if (config.apiToken)
    return { apiUrl: config.apiUrl, apiToken: config.apiToken };
  try {
    const parsed = JSON.parse(
      readFileSync(config.hindsightConfigPath, "utf8"),
    ) as {
      apiUrl?: unknown;
      apiToken?: unknown;
      apiKey?: unknown;
    };
    const apiUrl =
      typeof parsed.apiUrl === "string" && parsed.apiUrl.trim()
        ? parsed.apiUrl
        : config.apiUrl;
    let token: string | undefined;
    if (typeof parsed.apiToken === "string" && parsed.apiToken.trim()) {
      token = parsed.apiToken;
    } else if (typeof parsed.apiKey === "string" && parsed.apiKey.trim()) {
      token = parsed.apiKey;
    }
    if (token) return { apiUrl, apiToken: token };
    return { apiUrl };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { apiUrl: config.apiUrl };
    throw error;
  }
}

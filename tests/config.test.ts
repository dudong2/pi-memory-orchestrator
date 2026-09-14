import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, parseConfig } from "../src/config.js";

test("parseConfig returns safe shadow defaults", () => {
  const config = parseConfig(undefined);
  assert.equal(config.mode, "shadow");
  assert.equal(config.bankId, "coding-agent::dudong2");
  assert.equal(config.shadowBankId, "coding-agent::dudong2::shadow");
  assert.equal(config.requestTimeoutMs, 30_000);
  assert.equal(config.markerName, ".pi-memory-scope.json");
});

test("parseConfig accepts explicit active settings", () => {
  const config = parseConfig({ mode: "active", requestTimeoutMs: 10_000, maxRecallTokens: 2_048 });
  assert.equal(config.mode, "active");
  assert.equal(config.requestTimeoutMs, 10_000);
  assert.equal(config.maxRecallTokens, 2_048);
  assert.equal(config.apiUrl, DEFAULT_CONFIG.apiUrl);
});

test("parseConfig rejects invalid timeout", () => {
  assert.throws(() => parseConfig({ requestTimeoutMs: 0 }), /positive integer/);
});

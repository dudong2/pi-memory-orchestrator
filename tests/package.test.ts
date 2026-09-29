import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

interface DependencyManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const manifest: DependencyManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

const hostPackages = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];

test("host-provided extension packages are wildcard peers, not runtime dependencies", () => {
  for (const name of hostPackages) {
    assert.equal(manifest.dependencies?.[name], undefined, `${name} must not be bundled`);
    if (manifest.devDependencies?.[name] || manifest.peerDependencies?.[name]) {
      assert.equal(manifest.peerDependencies?.[name], "*", `${name} must be a wildcard peer`);
    }
  }
  assert.equal(manifest.peerDependencies?.typebox, "*");
  assert.ok(manifest.devDependencies?.typebox, "typebox must remain available for development");
});

test("lockfile root dependency declarations match the extension manifest", () => {
  const lock: { packages: Record<string, DependencyManifest> } = JSON.parse(
    readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
    assert.deepEqual(lock.packages[""][field], manifest[field], `${field} must stay in sync`);
  }
});

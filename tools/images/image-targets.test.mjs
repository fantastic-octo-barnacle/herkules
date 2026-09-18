import assert from "node:assert/strict";
import test from "node:test";
import { selectImageTargets } from "./image-targets.mjs";
test("shared UI affects both browser images", () => {
  assert.deepEqual(selectImageTargets(["packages/ui/src/button.tsx"]).targets, ["bbs", "platform"]);
});
test("application routes travel with the platform artifact", () => {
  assert.deepEqual(selectImageTargets(["tools/images/caddy/mcp/bbs.caddy"]).targets, ["platform"]);
});
test("documentation and infrastructure do not build application images", () => {
  assert.deepEqual(selectImageTargets(["README.md", "tools/deploy/Caddyfile"]).targets, []);
});

test("lockfile and publication machinery invalidate the complete image tuple", () => {
  for (const path of [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".dockerignore",
    ".github/workflows/image-build.yml",
    "tools/images/image-targets.mjs",
  ]) {
    assert.deepEqual(selectImageTargets([path]).targets, ["auth", "bbs", "ai", "platform"]);
  }
});
test("docs and license changes do not require images; AI source does", () => {
  assert.equal(
    selectImageTargets(["docs/auth.md", "LICENSE-MIT", "KNOWN_ISSUES.md"]).deploy,
    false,
  );
  assert.deepEqual(selectImageTargets(["services/inference/src/gateway.ts"]).targets, ["ai"]);
});

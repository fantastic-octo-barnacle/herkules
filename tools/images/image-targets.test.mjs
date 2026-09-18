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

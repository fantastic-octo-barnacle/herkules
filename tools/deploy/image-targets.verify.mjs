import assert from "node:assert/strict";
import test from "node:test";

import { selectImageTargets } from "./image-targets.mjs";

test("selects only the BBS image for BBS source", () => {
  assert.deepEqual(selectImageTargets(["apps/bbs/src/main.ts"]), {
    targets: ["bbs"],
    deploy: true,
  });
});

test("follows shared package dependencies", () => {
  assert.deepEqual(selectImageTargets(["packages/auth-middleware/src/index.ts"]), {
    targets: ["auth", "bbs"],
    deploy: true,
  });
  assert.deepEqual(selectImageTargets(["packages/ui/src/Button.tsx"]), {
    targets: ["bbs", "caddy"],
    deploy: true,
  });
});

test("deploys bind-mounted configuration without rebuilding images", () => {
  assert.deepEqual(selectImageTargets(["tools/deploy/gatus.yaml"]), {
    targets: [],
    deploy: true,
  });
});

test("does not deploy documentation or backup test changes", () => {
  assert.deepEqual(selectImageTargets(["docs/README.md", "tools/deploy/backup/backup.test.sh"]), {
    targets: [],
    deploy: false,
  });
});

test("treats the shared Dockerfile and manual builds conservatively", () => {
  assert.deepEqual(selectImageTargets(["Dockerfile"]), {
    targets: ["auth", "bbs", "caddy", "backup"],
    deploy: true,
  });
  assert.deepEqual(selectImageTargets([], { all: true }), {
    targets: ["auth", "bbs", "caddy", "backup"],
    deploy: true,
  });
});

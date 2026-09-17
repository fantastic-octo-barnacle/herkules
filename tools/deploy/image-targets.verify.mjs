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
  assert.deepEqual(selectImageTargets(["packages/ui/src/components/button.tsx"]), {
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
  assert.deepEqual(
    selectImageTargets([
      "docs/README.md",
      "apps/bbs/README.md",
      "apps/bbs/drizzle/README.md",
      "apps/bbs/scripts/export.mjs",
      "apps/bbs/tests/export.test.ts",
      "services/auth/tests/flow.test.ts",
      "services/web/README.md",
      "tools/deploy/backup/backup.test.sh",
    ]),
    {
      targets: [],
      deploy: false,
    },
  );
});

test("keeps package manifests and build configuration conservative", () => {
  assert.deepEqual(
    selectImageTargets([
      "apps/bbs/package.json",
      "services/auth/vite.config.ts",
      "services/web/index.html",
    ]),
    { targets: ["auth", "bbs", "caddy"], deploy: true },
  );
});

test("includes the nested BBS web build root but not fixtures", () => {
  assert.deepEqual(
    selectImageTargets([
      "apps/bbs/web/index.html",
      "apps/bbs/web/tsconfig.json",
      "apps/bbs/web/vite.config.ts",
    ]),
    { targets: ["bbs"], deploy: true },
  );
  assert.deepEqual(selectImageTargets(["apps/bbs/tests/fixtures/index.html"]), {
    targets: [],
    deploy: false,
  });
});

test("deploys a changed release applicator without rebuilding images", () => {
  assert.deepEqual(selectImageTargets(["tools/deploy/apply-release.sh"]), {
    targets: [],
    deploy: true,
  });
});

test("treats the shared Dockerfile and manual builds conservatively", () => {
  assert.deepEqual(selectImageTargets(["Dockerfile"]), {
    targets: ["auth", "bbs", "caddy", "backup", "ai"],
    deploy: true,
  });
  assert.deepEqual(selectImageTargets(["tools/deploy/docker-bake.hcl"]), {
    targets: ["auth", "bbs", "caddy", "backup", "ai"],
    deploy: true,
  });
  assert.deepEqual(selectImageTargets([], { all: true }), {
    targets: ["auth", "bbs", "caddy", "backup", "ai"],
    deploy: true,
  });
});

test("rebuilds Caddy when its TLS validation changes", () => {
  assert.deepEqual(selectImageTargets(["tools/deploy/caddy/entrypoint.sh"]), {
    targets: ["caddy"],
    deploy: true,
  });
});

test("inference source rebuilds only the ai image", () => {
  assert.deepEqual(selectImageTargets(["services/inference/src/gateway.ts"]), {
    targets: ["ai"],
    deploy: true,
  });
});

test("portal patches rebuild the image that serves their assets", () => {
  assert.deepEqual(selectImageTargets(["tools/ai/portal/edits.json"]), {
    targets: ["ai"],
    deploy: true,
  });
});

test("edge rollout code deploys without rebuilding unchanged application images", () => {
  assert.deepEqual(selectImageTargets(["tools/deploy/cloudflare/release.mjs"]), {
    targets: [],
    deploy: true,
  });
  assert.deepEqual(selectImageTargets(["tools/deploy/cloudflare/release.test.mjs"]), {
    targets: [],
    deploy: false,
  });
});

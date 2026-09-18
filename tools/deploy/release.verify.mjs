import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createRelease,
  environmentFor,
  planRelease,
  validateRelease,
  verifyBundle,
} from "./release.mjs";

const SHA = "a".repeat(40);
const DIGESTS = {
  auth: image("auth", "1"),
  bbs: image("bbs", "2"),
  caddy: image("caddy", "3"),
  backup: image("backup", "4"),
  ai: image("ai", "6"),
};

test("creates an initial release and emits the Compose environment", async () => {
  const bundle = await fixture();
  const release = await createRelease({
    sourceSha: SHA,
    bundleDir: bundle,
    updates: Object.entries(DIGESTS).map(([target, ref]) => ({ target, image: ref })),
    createdAt: new Date("2026-09-02T00:00:00.000Z"),
  });

  assert.equal(validateRelease(release), release);
  assert.equal(await verifyBundle(release, bundle), release);
  assert.deepEqual(release.images, DIGESTS);
  assert.match(release.config.caddy, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    environmentFor(release),
    [
      `AUTH_IMAGE_REF=${DIGESTS.auth}`,
      `BBS_IMAGE_REF=${DIGESTS.bbs}`,
      `CADDY_IMAGE_REF=${DIGESTS.caddy}`,
      `BACKUP_IMAGE_REF=${DIGESTS.backup}`,
      `AI_IMAGE_REF=${DIGESTS.ai}`,
      "DEPLOY_CONFIG_DIR=./active-config",
      "",
    ].join("\n"),
  );
});

test("changes one image without giving unchanged images a new version", async () => {
  const bundle = await fixture();
  const base = await createRelease({
    sourceSha: SHA,
    bundleDir: bundle,
    updates: Object.entries(DIGESTS).map(([target, ref]) => ({ target, image: ref })),
  });
  const nextBbs = image("bbs", "5");
  const candidate = await createRelease({
    base,
    baseReference: `ghcr.io/acme/herkules/release@sha256:${"9".repeat(64)}`,
    sourceSha: "b".repeat(40),
    bundleDir: bundle,
    updates: [{ target: "bbs", image: nextBbs }],
  });

  assert.deepEqual(candidate.images, { ...DIGESTS, bbs: nextBbs });
  assert.deepEqual(planRelease(base, candidate), {
    images: ["bbs"],
    recreate: [],
    composeChanged: false,
  });
});

test("plans explicit recreation for changed bind-mounted configuration", async () => {
  const firstBundle = await fixture();
  const secondBundle = await fixture({ caddy: "changed", gatus: "changed" });
  const updates = Object.entries(DIGESTS).map(([target, ref]) => ({ target, image: ref }));
  const first = await createRelease({ sourceSha: SHA, bundleDir: firstBundle, updates });
  const second = await createRelease({
    base: first,
    baseReference: `ghcr.io/acme/herkules/release@sha256:${"9".repeat(64)}`,
    sourceSha: "b".repeat(40),
    bundleDir: secondBundle,
  });

  assert.deepEqual(planRelease(first, second), {
    images: [],
    recreate: ["caddy", "gatus"],
    composeChanged: false,
  });
});

test("leaves recreation to Compose when the image changed as well", async () => {
  const firstBundle = await fixture();
  const secondBundle = await fixture({ caddy: "changed" });
  const updates = Object.entries(DIGESTS).map(([target, ref]) => ({ target, image: ref }));
  const first = await createRelease({ sourceSha: SHA, bundleDir: firstBundle, updates });
  const second = await createRelease({
    base: first,
    baseReference: `ghcr.io/acme/herkules/release@sha256:${"9".repeat(64)}`,
    sourceSha: SHA,
    bundleDir: secondBundle,
    updates: [{ target: "caddy", image: image("caddy", "9") }],
  });

  assert.deepEqual(planRelease(first, second), {
    images: ["caddy"],
    recreate: [],
    composeChanged: false,
  });
  assert.deepEqual(planRelease(null, second).recreate, ["gatus"]);
});

test("reads a release from before the ai split as running AI from its auth image", async () => {
  const bundle = await fixture();
  const { ai: _ai, ...legacyImages } = DIGESTS;
  const current = await createRelease({
    sourceSha: SHA,
    bundleDir: bundle,
    updates: Object.entries(DIGESTS).map(([target, ref]) => ({ target, image: ref })),
  });
  const legacy = { ...current, images: legacyImages };

  assert.equal(validateRelease(legacy), legacy);
  assert.match(environmentFor(legacy), new RegExp(`^AI_IMAGE_REF=${escape(DIGESTS.auth)}$`, "m"));

  // A release built on a legacy base keeps AI on the old auth image until ai itself is rebuilt.
  const nextAuth = image("auth", "7");
  const candidate = await createRelease({
    base: legacy,
    baseReference: `ghcr.io/acme/herkules/release@sha256:${"9".repeat(64)}`,
    sourceSha: "b".repeat(40),
    bundleDir: bundle,
    updates: [{ target: "auth", image: nextAuth }],
  });
  assert.deepEqual(candidate.images, { ...legacyImages, auth: nextAuth, ai: DIGESTS.auth });
  assert.deepEqual(planRelease(legacy, candidate).images, ["auth"]);
});

test("rejects mutable image references", async () => {
  const bundle = await fixture();
  await assert.rejects(
    createRelease({
      sourceSha: SHA,
      bundleDir: bundle,
      updates: [{ target: "auth", image: "ghcr.io/acme/herkules/auth:latest" }],
    }),
    /immutable ghcr.io digest reference/,
  );
});

test("detects deployment files changed after release assembly", async () => {
  const bundle = await fixture();
  const release = await createRelease({
    sourceSha: SHA,
    bundleDir: bundle,
    updates: Object.entries(DIGESTS).map(([target, ref]) => ({ target, image: ref })),
  });
  await writeFile(join(bundle, "Caddyfile"), "tampered\n");
  await assert.rejects(verifyBundle(release, bundle), /caddy config does not match/);
});

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function image(target, digit) {
  return `ghcr.io/acme/herkules/${target}:sha-deadbee@sha256:${digit.repeat(64)}`;
}

async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "herkules-release-"));
  await mkdir(join(root, "caddy/services"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "docker-compose.yml"), "services: {}\n"),
    writeFile(join(root, "Caddyfile"), `${overrides.caddy ?? "caddy"}\n`),
    writeFile(join(root, "caddy/services/bbs.caddy"), "reverse_proxy bbs\n"),
    writeFile(join(root, "gatus.yaml"), `${overrides.gatus ?? "gatus"}\n`),
    writeFile(join(root, "apply-release.sh"), "#!/bin/sh\n"),
    writeFile(join(root, "compose.sh"), "#!/bin/sh\n"),
  ]);
  return root;
}

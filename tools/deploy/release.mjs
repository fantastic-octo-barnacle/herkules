import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const IMAGE_TARGETS = ["auth", "bbs", "caddy", "backup"];

const SHA = /^[0-9a-f]{40}$/;
const IMAGE_REF = /^ghcr\.io\/[a-z0-9_./-]+(?::[a-zA-Z0-9_.-]+)?@sha256:[0-9a-f]{64}$/;
const RELEASE_REF = /^ghcr\.io\/[a-z0-9_./-]+@sha256:[0-9a-f]{64}$/;
const REASONS = new Set(["deploy", "rollback-component"]);

export async function createRelease({
  base = null,
  baseReference = null,
  updates = [],
  sourceSha,
  bundleDir,
  reason = "deploy",
  createdAt = new Date(),
}) {
  if (base !== null) validateRelease(base);
  if (!SHA.test(sourceSha)) throw new TypeError("sourceSha must be a full lowercase Git SHA");
  if (!REASONS.has(reason)) throw new TypeError(`unsupported release reason: ${reason}`);
  if (base === null && baseReference !== null) {
    throw new TypeError("baseReference requires a base release");
  }
  if (base !== null && !RELEASE_REF.test(baseReference ?? "")) {
    throw new TypeError("a base release requires its immutable OCI reference");
  }

  const images = { ...base?.images };
  const seen = new Set();
  for (const update of updates) {
    if (!IMAGE_TARGETS.includes(update.target)) {
      throw new TypeError(`unknown image target: ${String(update.target)}`);
    }
    if (seen.has(update.target)) throw new TypeError(`duplicate image target: ${update.target}`);
    if (!IMAGE_REF.test(update.image)) {
      throw new TypeError(`${update.target} image must be an immutable ghcr.io digest reference`);
    }
    seen.add(update.target);
    images[update.target] = update.image;
  }
  for (const target of IMAGE_TARGETS) {
    if (!IMAGE_REF.test(images[target] ?? "")) {
      throw new TypeError(`release has no immutable ${target} image`);
    }
  }

  const release = {
    schemaVersion: 1,
    sourceSha,
    createdAt: createdAt.toISOString(),
    reason,
    parentRelease: baseReference,
    images: Object.fromEntries(IMAGE_TARGETS.map((target) => [target, images[target]])),
    config: await configDigests(bundleDir),
  };
  validateRelease(release);
  return release;
}

export function validateRelease(value) {
  if (!value || value.schemaVersion !== 1) throw new TypeError("unsupported release schema");
  if (!SHA.test(value.sourceSha ?? "")) throw new TypeError("release sourceSha is invalid");
  if (Number.isNaN(Date.parse(value.createdAt ?? ""))) {
    throw new TypeError("release createdAt is invalid");
  }
  if (!REASONS.has(value.reason)) throw new TypeError("release reason is invalid");
  if (value.parentRelease !== null && !RELEASE_REF.test(value.parentRelease ?? "")) {
    throw new TypeError("release parentReference is invalid");
  }
  for (const target of IMAGE_TARGETS) {
    if (!IMAGE_REF.test(value.images?.[target] ?? "")) {
      throw new TypeError(`release ${target} image is invalid`);
    }
  }
  for (const name of ["compose", "caddy", "gatus", "apply"]) {
    if (!/^sha256:[0-9a-f]{64}$/.test(value.config?.[name] ?? "")) {
      throw new TypeError(`release ${name} config digest is invalid`);
    }
  }
  return value;
}

export async function verifyBundle(release, bundleDir) {
  validateRelease(release);
  const actual = await configDigests(bundleDir);
  for (const [name, digest] of Object.entries(actual)) {
    if (release.config[name] !== digest) {
      throw new TypeError(`release ${name} config does not match its bundle`);
    }
  }
  return release;
}

export function environmentFor(release) {
  validateRelease(release);
  const names = {
    auth: "AUTH_IMAGE_REF",
    bbs: "BBS_IMAGE_REF",
    caddy: "CADDY_IMAGE_REF",
    backup: "BACKUP_IMAGE_REF",
  };
  return [
    ...IMAGE_TARGETS.map((target) => `${names[target]}=${release.images[target]}`),
    "DEPLOY_CONFIG_DIR=./active-config",
    "",
  ].join("\n");
}

export function planRelease(current, candidate) {
  if (current !== null) validateRelease(current);
  validateRelease(candidate);
  const images = IMAGE_TARGETS.filter(
    (target) => current === null || current.images[target] !== candidate.images[target],
  );
  const recreate = [];
  if (current === null || current.config.caddy !== candidate.config.caddy) recreate.push("caddy");
  if (current === null || current.config.gatus !== candidate.config.gatus) recreate.push("gatus");
  return {
    images,
    recreate,
    composeChanged: current === null || current.config.compose !== candidate.config.compose,
  };
}

async function configDigests(bundleDir) {
  const root = resolve(bundleDir);
  return {
    compose: await digestPaths(root, ["docker-compose.yml"]),
    caddy: await digestPaths(root, ["Caddyfile", "caddy/services"]),
    gatus: await digestPaths(root, ["gatus.yaml"]),
    apply: await digestPaths(root, ["apply-release.sh", "compose.sh"]),
  };
}

async function digestPaths(root, paths) {
  const files = [];
  for (const path of paths) await collectFiles(root, resolve(root, path), files);
  files.sort((a, b) => a.localeCompare(b));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(root, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function collectFiles(root, path, output) {
  if (!path.startsWith(`${root}/`) && path !== root)
    throw new Error("bundle path escaped its root");
  const entries = await readdir(path, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOTDIR") return null;
    throw error;
  });
  if (entries === null) {
    output.push(path);
    return;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await collectFiles(root, child, output);
    else if (entry.isFile()) output.push(child);
    else throw new TypeError(`bundle contains unsupported entry: ${relative(root, child)}`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readUpdates(directory) {
  const paths = await readdir(directory).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  return Promise.all(
    paths
      .filter((path) => path.endsWith(".json"))
      .sort((a, b) => a.localeCompare(b))
      .map((path) => readJson(join(directory, path))),
  );
}

async function writeOutput(path, contents) {
  if (path) await writeFile(path, contents);
  else process.stdout.write(contents);
}

async function main() {
  const command = process.argv[2];
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      base: { type: "string" },
      "base-ref": { type: "string" },
      bundle: { type: "string" },
      candidate: { type: "string" },
      current: { type: "string" },
      output: { type: "string" },
      reason: { type: "string" },
      release: { type: "string" },
      source: { type: "string" },
      updates: { type: "string" },
    },
    strict: true,
  });

  if (command === "create") {
    if (!values.bundle || !values.source || !values.updates) {
      throw new TypeError("create requires --bundle, --source and --updates");
    }
    const base = values.base ? await readJson(values.base) : null;
    const release = await createRelease({
      base,
      baseReference: values["base-ref"] ?? null,
      updates: await readUpdates(values.updates),
      sourceSha: values.source,
      bundleDir: values.bundle,
      reason: values.reason ?? "deploy",
    });
    await writeOutput(values.output, `${JSON.stringify(release, null, 2)}\n`);
    return;
  }
  if (command === "env") {
    if (!values.release) throw new TypeError("env requires --release");
    await writeOutput(values.output, environmentFor(await readJson(values.release)));
    return;
  }
  if (command === "plan") {
    if (!values.candidate) throw new TypeError("plan requires --candidate");
    const current = values.current ? await readJson(values.current) : null;
    const plan = planRelease(current, await readJson(values.candidate));
    await writeOutput(values.output, `${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  if (command === "verify") {
    if (!values.release) throw new TypeError("verify requires --release");
    const release = await readJson(values.release);
    if (values.bundle) await verifyBundle(release, values.bundle);
    else validateRelease(release);
    return;
  }
  throw new TypeError(`usage: ${basename(process.argv[1])} create|env|plan|verify [options]`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

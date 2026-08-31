import { pathToFileURL } from "node:url";

const allTargets = ["auth", "bbs", "caddy", "backup"];
const nodeBuildInputs = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "vite.config.ts",
]);
const deploymentFiles = new Set([
  "tools/deploy/docker-compose.yml",
  "tools/deploy/Caddyfile",
  "tools/deploy/gatus.yaml",
]);
const backupImageFiles = new Set([
  "tools/deploy/backup/backup.sh",
  "tools/deploy/backup/crontab",
  "tools/deploy/backup/entrypoint.sh",
]);

export function selectImageTargets(paths, { all = false } = {}) {
  if (all) return { targets: allTargets, deploy: true };

  const targets = new Set();
  let deploy = false;
  const add = (...names) => names.forEach((name) => targets.add(name));

  for (const path of paths) {
    if (!path) continue;
    if (path === "Dockerfile") add(...allTargets);
    if (nodeBuildInputs.has(path) || path.startsWith("tsconfig")) add("auth", "bbs", "caddy");
    if (path.startsWith("services/auth/")) add("auth");
    if (path.startsWith("services/web/")) add("caddy");
    if (path.startsWith("apps/bbs/")) add("bbs");
    if (path.startsWith("packages/auth-middleware/")) add("auth", "bbs");
    if (path.startsWith("packages/oauth-client/")) add("bbs");
    if (path.startsWith("packages/ui/")) add("bbs", "caddy");
    if (backupImageFiles.has(path)) add("backup");
    if (deploymentFiles.has(path) || path.startsWith("tools/deploy/caddy/services/")) deploy = true;
  }

  const selected = allTargets.filter((target) => targets.has(target));
  return { targets: selected, deploy: deploy || selected.length > 0 };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const all = process.argv.includes("--all");
  let input = "";
  if (!all) {
    for await (const chunk of process.stdin) input += chunk;
  }
  const paths = input.split("\n");
  process.stdout.write(`${JSON.stringify(selectImageTargets(paths, { all }))}\n`);
}

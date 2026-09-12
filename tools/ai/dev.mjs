import { mkdir, readFile, writeFile, chmod, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dir = join(homedir(), ".config/herkules/ai/dev");
await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
const secret = async (name) => {
  const path = join(dir, name);
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const value = randomBytes(32).toString("hex");
  await writeFile(path, value + "\n", { mode: 0o600, flag: "wx" });
  return value;
};
const runnerFile = join(dir, "runner.json");
function processIdentity(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}
async function runningPid() {
  let runner;
  try {
    runner = JSON.parse(await readFile(runnerFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!Number.isSafeInteger(runner.pid) || runner.pid <= 0) return;
  // Compare command and start time so a stale file cannot signal a reused PID.
  if (runner.identity && processIdentity(runner.pid) === runner.identity) return runner.pid;
}
const activePid = await runningPid();
if (process.argv[2] !== "stop" && activePid)
  throw new Error("The local AI preview is already running. Stop it first.");
const db = await secret("db-password");
const session = await secret("session-secret");
const mock = await secret("mock-key");
for (const name of ["client-secret", "sync-secret", "root-password", "dispatch-key"])
  await secret(name);
await writeFile(
  join(dir, "init.sql"),
  `CREATE ROLE herkules_ai LOGIN PASSWORD '${db}' NOSUPERUSER NOCREATEDB NOCREATEROLE;\nCREATE DATABASE herkules_ai OWNER herkules_ai;\nCREATE ROLE ai_metadata LOGIN PASSWORD '${db}' NOSUPERUSER NOCREATEDB NOCREATEROLE;\n`,
  { mode: 0o600 },
);
await writeFile(
  join(dir, "workers.json"),
  JSON.stringify([
    {
      id: "mock",
      model: "qwen3.8-27b",
      url: "http://localhost:4015",
      keyFile: join(dir, "mock-key"),
    },
  ]),
  { mode: 0o600 },
);
const env = {
  ...process.env,
  AI_DEV_DB_PASSWORD: db,
  AI_DEV_SESSION_SECRET: session,
  AI_DEV_DIR: dir,
  AI_LOCAL_FIXTURES: "true",
  AI_LOCAL_AUTH_DB: `pglite://${join(dir, "auth-db")}`,
  AI_MOCK_KEY: mock,
  AI_PORTAL_DIR: join(dir, "portal"),
  AI_PORTAL_ORIGIN: "http://localhost:4010",
  AI_API_ORIGIN: "http://127.0.0.1:4010",
  PORT: "4010",
  INTERNAL_PORT: "4013",
  LISTEN_HOST: "127.0.0.1",
  NEW_API_URL: "http://localhost:4014",
  AUTH_ISSUER: "http://localhost:4012/auth",
  AUTH_INTERNAL_URL: "http://localhost:4012/auth",
  AI_DISPATCH_URL: "http://host.docker.internal:4013",
  AI_METADATA_DATABASE_URL: `postgres://ai_metadata:${db}@localhost:15433/herkules_ai`,
  AI_WORKERS_FILE: join(dir, "workers.json"),
  AI_CLIENT_SECRET_FILE: join(dir, "client-secret"),
  AI_SYNC_SECRET_FILE: join(dir, "sync-secret"),
  AI_ROOT_PASSWORD_FILE: join(dir, "root-password"),
  AI_DISPATCH_KEY_FILE: join(dir, "dispatch-key"),
};
const compose = (...args) => {
  const r = spawnSync(
    "docker",
    ["compose", "-f", join(root, "tools/ai/docker-compose.yml"), ...args],
    { env, stdio: "inherit" },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
};
if (process.argv[2] === "stop") {
  if (activePid) {
    process.kill(activePid, "SIGTERM");
    for (let i = 0; i < 100 && (await runningPid()); i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (await runningPid())
      throw new Error("Preview runner did not stop; Docker data is preserved.");
  }
  await unlink(runnerFile).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  compose("stop");
  process.exit(0);
}
const portalBuild = spawnSync(
  process.execPath,
  [join(root, "tools/ai/portal/build.mjs"), join(dir, "portal")],
  { stdio: "inherit" },
);
if (portalBuild.status !== 0) process.exit(portalBuild.status ?? 1);
compose("up", "-d", "--wait", "--wait-timeout", "120");
const view = `CREATE OR REPLACE VIEW herkules_token_identity AS SELECT encode(sha256(convert_to(key,'UTF8')),'hex') AS key_hash,user_id FROM tokens WHERE deleted_at IS NULL; GRANT CONNECT ON DATABASE herkules_ai TO ai_metadata; GRANT USAGE ON SCHEMA public TO ai_metadata; GRANT SELECT ON herkules_token_identity TO ai_metadata;`;
const sql = spawnSync(
  "docker",
  [
    "compose",
    "-f",
    join(root, "tools/ai/docker-compose.yml"),
    "exec",
    "-T",
    "postgres",
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "devadmin",
    "-d",
    "herkules_ai",
  ],
  { env, input: view, encoding: "utf8" },
);
if (sql.status !== 0) throw new Error("Local metadata view setup failed: " + sql.stderr);
// New API's Docker container reaches the host issuer through this back-channel.
const gatewayEnv = { ...env, AI_OAUTH_BACKCHANNEL: "http://host.docker.internal:4012/auth" };
const children = [];
const start = (file, e = env) => {
  const child = spawn(process.execPath, [join(root, file)], { env: e, stdio: "inherit" });
  children.push(child);
  child.on("exit", (code) => {
    if (!stopping) {
      shutdown();
      process.exitCode = code ?? 1;
    }
  });
  return child;
};
await writeFile(
  runnerFile,
  JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid) }),
  { mode: 0o600 },
);
let stopping = false;
const shutdown = () => {
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
};
process.on("exit", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
start("services/auth/scripts/ai-local.ts");
start("tools/ai/mock-worker.mjs");
async function healthy(url) {
  for (let i = 0; i < 60; i++) {
    if (stopping) throw new Error("Local AI startup stopped");
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  shutdown();
  throw new Error("Local AI service did not become healthy");
}
await healthy("http://localhost:4012/auth/healthz");
start("services/inference/src/main.ts", gatewayEnv);
await healthy("http://localhost:4010/healthz");
console.log("Local AI portal: http://localhost:4010 — choose Herkules, then Alice or Bob.");
console.log("Local API: http://127.0.0.1:4010/v1 — new accounts start with zero quota.");
console.log(
  "Private local New API admin: http://localhost:4014 — username herkulesroot; password is in " +
    join(dir, "root-password"),
);
console.log(
  "Ctrl-C stops host processes. Docker data is preserved; use `node tools/ai/dev.mjs stop` to stop the entire preview.",
);

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm, cp, mkdtemp } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const revision = "385d2dfd10d821b25c8a6766bd16eea248cb1652";
const checksum = "1ec3d28e23d72481e1c86642ed832f6bc0721cd2ed2b487618b0560c014d8aa5";
const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.argv[2] ?? "services/inference/dist/portal");
const editsText = await readFile(join(here, "edits.json"), "utf8");
const fingerprint = createHash("sha256")
  .update(checksum + editsText + (await readFile(fileURLToPath(import.meta.url))))
  .digest("hex");
try {
  if ((await readFile(join(output, ".build-id"), "utf8")) === fingerprint) {
    console.log("AI portal build is current");
    process.exit(0);
  }
} catch {}
const work = await mkdtemp(join(tmpdir(), "herkules-portal-"));
try {
  const response = await fetch(
    `https://codeload.github.com/QuantumNous/new-api/tar.gz/${revision}`,
  );
  if (!response.ok) throw new Error("Pinned portal source download failed");
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== checksum)
    throw new Error("Portal source checksum mismatch");
  await writeFile(join(work, "source.tar.gz"), archive);
  const source = join(work, "source");
  await mkdir(source);
  execFileSync("tar", ["-xzf", join(work, "source.tar.gz"), "--strip-components=1", "-C", source]);
  for (const edit of JSON.parse(editsText)) {
    const path = join(source, edit.file);
    const before = await readFile(path, "utf8");
    if (before.split(edit.before).length !== 2)
      throw new Error(`Portal patch no longer matches: ${edit.file}`);
    await writeFile(path, before.replace(edit.before, edit.after));
  }
  // Serve the exact modified source alongside the frontend, preserving upstream notices.
  await writeFile(
    join(source, "HERKULES-PORTAL.md"),
    `Based on New API ${revision}. UI changes remove notification preferences and wallet shortcuts. Build web/ with Bun 1.4.0: bun install --frozen-lockfile && bun run build. The unmodified backend is New API v1.0.0-rc.37.\n`,
  );
  execFileSync("tar", ["-czf", join(work, "portal-source.tar.gz"), "-C", source, "."]);
  execFileSync("bun", ["install", "--frozen-lockfile"], {
    cwd: join(source, "web"),
    stdio: "inherit",
  });
  execFileSync("bun", ["run", "typecheck"], { cwd: join(source, "web"), stdio: "inherit" });
  execFileSync("bun", ["run", "build"], {
    cwd: join(source, "web"),
    stdio: "inherit",
    env: { ...process.env, VITE_REACT_APP_VERSION: "v1.0.0-rc.37-herkules" },
  });
  await mkdir(output, { recursive: true });
  await cp(join(source, "web/dist"), output, { recursive: true });
  await cp(join(work, "portal-source.tar.gz"), join(output, "portal-source.tar.gz"));
  await writeFile(join(output, ".build-id"), fingerprint);
} finally {
  await rm(work, { recursive: true, force: true });
}

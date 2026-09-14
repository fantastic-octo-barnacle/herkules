import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = join(root, "tools/deploy/cloudflare/dist");
const headers = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  X-Herkules-Delivery: cloudflare-assets-experiment
`;

// Stage only public frontend output. Never upload the BBS server bundle.
await stat(join(root, "services/web/dist/index.html"));
await stat(join(root, "apps/bbs/dist/client/assets"));
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(join(root, "services/web/dist"), join(output, "platform"), { recursive: true });
await mkdir(join(output, "bbs-assets"));
await cp(join(root, "apps/bbs/dist/client/assets"), join(output, "bbs-assets/assets"), {
  recursive: true,
});
await writeFile(
  join(output, "platform/_headers"),
  `${headers}  Cache-Control: no-cache

/assets/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
`,
);
await writeFile(
  join(output, "bbs-assets/_headers"),
  `${headers}
/assets/*
  Cache-Control: public, max-age=31536000, immutable
`,
);
// Keep the origin's convenience redirect when the platform is activated.
await writeFile(join(output, "platform/_redirects"), "/ai https://ai-portal.herkules.dev 302\n");

async function inventory(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await inventory(path)));
    else {
      if (!entry.isFile()) throw new Error(`Unexpected asset type: ${path}`);
      const { size } = await stat(path);
      if (size > 25 * 1024 * 1024)
        throw new Error(`Asset exceeds Workers Free size limit: ${path}`);
      files.push({ path, size });
    }
  }
  return files;
}

for (const name of ["platform", "bbs-assets"]) {
  const files = await inventory(join(output, name));
  if (files.length > 20_000) throw new Error(`${name} exceeds Workers Free file count`);
  console.log(
    `${name}: ${files.length} files, ${files.reduce((sum, file) => sum + file.size, 0)} bytes`,
  );
}

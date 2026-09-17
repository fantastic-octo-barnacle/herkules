import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = process.env.EDGE_OUTPUT ?? join(root, "tools/deploy/cloudflare/dist");
const platformSource = process.env.EDGE_PLATFORM_SOURCE ?? join(root, "services/web/dist");
const bbsSource = process.env.EDGE_BBS_SOURCE ?? join(root, "apps/bbs/dist/client");
const headers = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  X-Herkules-Delivery: cloudflare-assets
`;

// Stage only public frontend output. Never upload the BBS server bundle.
await stat(join(platformSource, "index.html"));
await stat(join(bbsSource, "index.html"));
await stat(join(bbsSource, "assets"));
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(platformSource, join(output, "platform"), { recursive: true });
// Allowlist the browser build and known public files, rather than copying an
// arbitrary directory from an old release image. Server bundles stay excluded.
await mkdir(join(output, "bbs"));
for (const file of ["index.html", "assets", "favicon.svg", "robots.txt"]) {
  await cp(join(bbsSource, file), join(output, "bbs", file), { recursive: true });
}
await writeFile(
  join(output, "platform/_headers"),
  `${headers}  Cache-Control: no-cache

/assets/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
`,
);
await writeFile(
  join(output, "bbs/_headers"),
  `${headers}  Cache-Control: no-cache

/assets/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable

/favicon.svg
  ! Cache-Control
  Cache-Control: public, max-age=3600

/robots.txt
  ! Cache-Control
  Cache-Control: public, max-age=3600
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

for (const name of ["platform", "bbs"]) {
  const files = await inventory(join(output, name));
  if (files.length > 20_000) throw new Error(`${name} exceeds Workers Free file count`);
  console.log(
    `${name}: ${files.length} files, ${files.reduce((sum, file) => sum + file.size, 0)} bytes`,
  );
}

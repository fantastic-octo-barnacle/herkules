import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Return relative asset file paths, including nested directories; reject links. */
export async function assetFiles(root, prefix = "") {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await assetFiles(root, relative)));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unsupported asset entry: ${relative}`);
  }
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

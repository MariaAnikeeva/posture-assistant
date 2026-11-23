import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";
const root = path.resolve("dist/extension-unpacked");
const output = path.resolve("dist/posture-assistant-extension.zip");
const files = {};
async function collect(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isDirectory()) await collect(absolute, relative);
    else files[relative] = new Uint8Array(await readFile(absolute));
  }
}
await collect(root);
await writeFile(output, zipSync(files, { level: 6 }));
console.log("Created " + output);

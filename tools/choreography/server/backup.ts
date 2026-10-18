// One-time migration from a disk workspace to portable backups for static Studio.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Store } from "./store.ts";
const store = new Store(process.env.STUDIO_DATA_DIR || "studio-data");
const destination = path.resolve(process.argv[2] || "studio-backups");
await mkdir(destination, { recursive: true });
for (const summary of await store.list()) {
  const filename = path.join(destination, `${summary.projectId}.aerodance-project.zip`);
  await writeFile(filename, await store.download(summary.projectId, "backup"), { flag: "wx" });
  console.log(filename);
}

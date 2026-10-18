import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { staticStudio, browserStore } from "./static-helpers.ts";
import { baseUrl } from "./helpers.ts";
import { newProject } from "../core.ts";
import { createStudio } from "../server/index.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as Api from "../web/api.ts";

const { app, dispose } = await staticStudio(), server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const base = baseUrl(server), browser = await (process.env.STUDIO_TEST_BROWSER === "webkit" ? webkit.launch() : chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] }));
const diskRoot = await mkdtemp(path.join(tmpdir(), "studio-migrate-"));
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(base + "/__test__/empty.html");
  const store = browserStore(page), created = await store.save(newProject("browser-storage"), null);
  const second = await context.newPage();
  await second.goto(base + "/__test__/empty.html");
  const other = browserStore(second), initial = await other.project(created.projectId);
  const edits = [structuredClone(created), structuredClone(initial)];
  edits[0].metadata.title = "First tab"; edits[1].metadata.title = "Second tab";
  const race = await Promise.allSettled([store.save(edits[0], initial.revision), other.save(edits[1], initial.revision)]);
  assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(race.filter(r => r.status === "rejected").length, 1);
  const saved = await store.project(created.projectId);
  assert.equal(saved.revision, created.revision + 1);

  // Persist real OPFS assets, then force a metadata write to fail after another
  // write has already been queued. Both the old project and its asset must survive.
  await page.evaluate(async projectId => {
    const url = "/__test__/storage.js", { workspace }: typeof Api = await import(url);
    const p = await workspace.project(projectId);
    await workspace.uploadAudio(projectId, new Uint8Array([1, 2, 3]), "audio/wav", 1000, p.revision, "original.wav");
    const before = await workspace.project(projectId);
    const put = IDBObjectStore.prototype.put;
    let writes = 0;
    IDBObjectStore.prototype.put = function (...args) {
      if (++writes === 2) throw new DOMException("Injected disk full", "QuotaExceededError");
      return put.apply(this, args);
    };
    try {
      let failed = false;
      try { await workspace.uploadAudio(projectId, new Uint8Array([4, 5, 6]), "audio/wav", 2000, before.revision, "replacement.wav"); }
      catch { failed = true; }
      if (!failed) throw Error("Expected quota failure");
    } finally { IDBObjectStore.prototype.put = put; }
    const after = await workspace.project(projectId);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw Error("Partial metadata committed");
    if (String(new Uint8Array(await (await workspace.audio(projectId)).arrayBuffer())) !== "1,2,3") throw Error("Original asset lost");
  }, created.projectId);
  await page.evaluate(async projectId => {
    const url = "/__test__/storage.js", { workspace }: typeof Api = await import(url);
    const before = await workspace.project(projectId), createWritable = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async () => { throw new DOMException("Injected OPFS quota", "QuotaExceededError"); };
    try {
      let failed = false;
      try { await workspace.uploadAudio(projectId, new Uint8Array([9]), "audio/wav", 2000, before.revision, "failed.wav"); }
      catch { failed = true; }
      if (!failed) throw Error("Expected OPFS quota failure");
    } finally { FileSystemFileHandle.prototype.createWritable = createWritable; }
    if (JSON.stringify(before) !== JSON.stringify(await workspace.project(projectId))) throw Error("OPFS failure changed metadata");
  }, created.projectId);
  await page.reload();
  assert.equal((await store.project(created.projectId)).metadata.title, saved.metadata.title);
  const backup = await store.download(created.projectId, "backup");
  assert.ok(backup.length > 0);
  // Existing disk backups import unchanged into browser storage; browser backups
  // are still consumable by the legacy tool.
  const disk = createStudio({ dataDir: diskRoot }).store;
  const diskProject = await disk.save(newProject("disk-project"), null);
  const oldBackup = await disk.download(diskProject.projectId, "backup");
  const migrated = await page.evaluate(async bytes => {
    const url = "/__test__/storage.js", { workspace }: typeof Api = await import(url);
    return workspace.restore(new Uint8Array(bytes));
  }, Array.from(oldBackup));
  assert.equal(migrated.songId, diskProject.songId);
  assert.notEqual(migrated.projectId, diskProject.projectId);
  const roundTrip = await disk.restore(backup);
  assert.equal(roundTrip.metadata.title, saved.metadata.title);
  assert.deepEqual(new Uint8Array(await (await disk.audio(roundTrip.projectId)).arrayBuffer()), new Uint8Array([1, 2, 3]));

  // A failed restore must leave neither a visible project nor hidden asset files.
  const countBefore = (await store.list()).length;
  await assert.rejects(page.evaluate(async bytes => {
    const url = "/__test__/storage.js", { workspace }: typeof Api = await import(url);
    const tx = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = () => { throw new DOMException("Injected quota", "QuotaExceededError"); };
    try { await workspace.restore(new Uint8Array(bytes)); }
    finally { IDBObjectStore.prototype.put = tx; }
  }, Array.from(backup)), /quota/i);
  assert.equal((await store.list()).length, countBefore);
  await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("aerodance-studio");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("aerodance-studio", 1);
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    const entries = await new Promise<{ blob?: string }[]>((resolve, reject) => {
      const req = db.transaction("files").objectStore("files").getAll();
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    db.close();
    const live = new Set(entries.flatMap(e => e.blob ? [e.blob] : []));
    for await (const name of root.keys()) if (!live.has(name)) throw Error("Leaked uncommitted asset");
  });
  // Deletion is serialized against stale writes from a second tab.
  const stale = await other.project(created.projectId);
  await store.remove(created.projectId, stale.revision);
  await assert.rejects(other.save(stale, stale.revision), /changed/);
  await assert.rejects(store.project(created.projectId), /not found/);

  // The actual built UI must never call a backend, including backup and reload.
  const apiRequests: string[] = [];
  await page.route("**/api/**", route => { apiRequests.push(route.request().url()); return route.abort(); });
  await page.addInitScript(() => {
    for (const Type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!Type) continue;
      for (const name of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"])
        if (name in Type.prototype) Reflect.set(Type.prototype, name, () => {});
    }
  });
  await page.goto(base);
  await page.getByRole("heading", { name: "Make every move yours." }).waitFor();
  await page.getByRole("button", { name: "Song details", exact: true }).click();
  await page.getByLabel("Song name", { exact: true }).fill("Unsaved after quota");
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    Object.assign(window, { restoreStoragePut: () => { IDBObjectStore.prototype.put = put; } });
    IDBObjectStore.prototype.put = () => { throw new DOMException("Injected full storage", "QuotaExceededError"); };
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: /Browser storage is full/ }).waitFor();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Backup", exact: true }).click();
  assert.ok((await download).suggestedFilename().endsWith(".aerodance-project.zip"));
  await page.getByRole("alert").filter({ hasText: /Backup contains the last saved revision/ }).waitFor();
  await page.evaluate(() => { const restore = Reflect.get(window, "restoreStoragePut"); if (typeof restore === "function") restore(); });
  page.once("dialog", dialog => dialog.accept());
  await page.reload();
  await page.getByRole("heading", { name: "Make every move yours." }).waitFor();
  assert.deepEqual(apiRequests, []);
  console.log("Browser storage passed: cross-tab revision race, OPFS assets, quota rollback, legacy backup migration, atomic restore, deletion, and static UI backup/reload with no API requests.");
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve)); await dispose(); await rm(diskRoot, { recursive: true, force: true });
}

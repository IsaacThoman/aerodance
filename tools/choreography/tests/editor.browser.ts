// Regression for panel navigation, playable bounds, and metadata performance on a long routine.
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { build } from "vite";
import { chromium } from "playwright";
import { staticStudio, browserStore } from "./static-helpers.ts";
import { baseUrl, openSidebar } from "./helpers.ts";
import { newProject, addTake, overwriteTracks, offsetTrack, trackDataIds } from "../core.ts";
import type { StudioAssets, Take } from "../core.ts";

type Work = Record<"compileProject" | "reviewTimeline" | "missingIntervalsFromTimeline", number>;
declare global { interface Window { editorWork: Work; metadataPaints: number[]; } }
const directory = await mkdtemp(path.join(tmpdir(), "studio-editor-regression-"));
// Instrument only the temporary test build; production has no counters or test bridge.
await build({ configFile: path.resolve("tools/choreography/vite.config.ts"), logLevel: "error",
  build: { outDir: directory, chunkSizeWarningLimit: 2000 }, plugins: [{
    name: "editor-work-counters", enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("/tools/choreography/core.ts")) return;
      for (const name of ["compileProject", "reviewTimeline", "missingIntervalsFromTimeline"])
        code = code.replace(new RegExp(`(export function ${name}\\([\\s\\S]*?\\)\\s*:\\s*[^\\{]+\\{)`),
          `$1\n globalThis.editorWork.${name}++;`);
      return code;
    },
  }] });
const { app, dispose } = await staticStudio(directory), server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } }), errors: string[] = [];
  page.setDefaultTimeout(30000);
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.editorWork = { compileProject: 0, reviewTimeline: 0, missingIntervalsFromTimeline: 0 };
    window.metadataPaints = [];
    document.addEventListener("input", event => {
      if (!(event.target instanceof HTMLInputElement) || !event.target.closest(".song-fields")) return;
      const start = performance.now();
      requestAnimationFrame(() => window.metadataPaints.push(performance.now() - start));
    });
    for (const Type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!Type) continue;
      for (const name of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"])
        if (name in Type.prototype) Reflect.set(Type.prototype, name, () => {});
    }
  });
  const base = baseUrl(server);
  await page.goto(base + "/__test__/empty.html");
  const store = browserStore(page), projectId = "editor-long-routine";
  const takeName = "Long take " + "unbroken-recording-filename".repeat(8) + ".webm";
  const source: Take = { schema: "aerodance.take", schemaVersion: 1, takeId: "long-take", name: takeName,
    source: "imported", input: { width: 640, height: 480, mirrored: false }, offsetMs: 0, timeScale: 1,
    samples: Array.from({ length: 901 }, (_, i) => ({ takeTimeMs: i * 200,
      poses: [0, 1].map(playerId => ({ playerId, landmarks: Array.from({ length: 33 }, (_, joint) => ({
        x: playerId ? .25 : .75, y: joint < 11 ? .2 : joint < 23 ? .4 : joint < 27 ? .6 : .9, z: 0, confidence: .95,
      })) })) })) };
  const take = await store.writeTake(projectId, source), assets: StudioAssets = new Map([[take.takeId, take]]);
  let project = overwriteTracks(addTake(newProject(projectId), take), take, [0, 1], assets);
  project.durationMs = 180000; project.playableStartMs = 10000; project.playableEndMs = 170000;
  for (let i = 0; i < 120; i++) project = offsetTrack(project, i % 2, i % 4 ? 0 : 10);
  for (const id of trackDataIds(project)) await store.writeTrack(projectId, assets.get(id));
  await store.save(project, null);
  await page.goto(base);
  await page.getByRole("heading", { name: "Preview", exact: true }).waitFor();
  await page.getByRole("button", { name: "Skeleton", exact: true }).click();
  assert.equal(await page.getByLabel("Webcam camera").count(), 0);
  assert.equal(await page.locator(".history").count(), 0);
  assert.match(await page.locator(".playable-readout").innerText(), /00:10.00.*02:50.00/s);
  const markings = await page.locator(".playable-overlay").innerHTML();
  await page.getByRole("slider", { name: "Selection start", exact: true }).press("ArrowRight");
  assert.equal(await page.locator(".playable-overlay").innerHTML(), markings);
  await page.getByRole("button", { name: "Set playable range", exact: true }).click();
  assert.notEqual(await page.locator(".playable-overlay").innerHTML(), markings);
  await page.getByRole("heading", { name: "Project", exact: true }).waitFor();
  assert.equal(await page.locator(".sidebar-nav").getByRole("button", { name: "Track options", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "P1 track options", exact: true }).getAttribute("aria-expanded"), "false");
  assert.equal(await page.getByRole("button", { name: "P2 track options", exact: true }).count(), 0);
  await openSidebar(page, "Track options");
  assert.equal(await page.getByRole("button", { name: "P1 track options", exact: true }).getAttribute("aria-expanded"), "true");
  await page.getByRole("button", { name: "Select P2", exact: true }).focus();
  await page.keyboard.press("Space");
  assert.equal(await page.getByRole("button", { name: "P1 track options", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "P2 track options", exact: true }).getAttribute("aria-expanded"), "true");
  assert.equal(await page.getByLabel("P1 offset (seconds)").count(), 0);
  assert.equal(await page.getByLabel("P2 offset (seconds)").count(), 1);
  assert.equal(await page.getByRole("button", { name: "Select P2 timeline track", exact: true }).getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "Select P1 timeline track", exact: true }).focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.getByRole("button", { name: "Select P1", exact: true }).getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "P1 track options", exact: true }).click();
  await page.getByRole("heading", { name: "Project", exact: true }).waitFor();
  await openSidebar(page, "History");
  assert.equal(await page.locator(".history li").count(), 121);
  await openSidebar(page, "Configuration");
  assert.equal(await page.getByLabel("Webcam camera").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Record new take", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Camera setup", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Live view", exact: true }).click();
  assert.equal(await page.getByLabel("Webcam camera").count(), 1);
  assert.equal(await page.getByRole("button", { name: "Record new take", exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Camera setup", exact: true }).count(), 1);
  // Expanded storage help must participate in panel scrolling and stay inside its width.
  for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }, { width: 320, height: 700 }]) {
    await page.setViewportSize(viewport);
    await openSidebar(page, "Configuration");
    await page.locator(".storage-status summary").click();
    await page.locator(".storage-status > div").scrollIntoViewIfNeeded();
    assert.ok(await page.locator(".storage-status").evaluate(details => {
      const panel = details.closest(".library")!.getBoundingClientRect();
      const body = details.querySelector("div")!.getBoundingClientRect();
      return body.left >= panel.left && body.right <= panel.right &&
        details.getBoundingClientRect().bottom >= body.bottom && body.right <= innerWidth;
    }), `storage help must stay in the Configuration panel at ${viewport.width}px`);
    await openSidebar(page, "Project");
    assert.ok(await page.locator(".take-select").evaluate(button => {
      const name = button.querySelector("strong")!, text = name.getBoundingClientRect();
      const box = button.getBoundingClientRect(), actions = button.parentElement!.querySelector("summary")!.getBoundingClientRect();
      return name.scrollWidth <= name.clientWidth + 1 && text.left >= box.left && text.right <= box.right && box.right <= actions.left && actions.right <= innerWidth;
    }), `long take names must wrap without covering actions at ${viewport.width}px`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.setViewportSize({ width: 1500, height: 1050 });
  await page.getByRole("button", { name: "Playback", exact: true }).click();
  await openSidebar(page, "Project");
  assert.equal(await page.getByLabel("Webcam camera").count(), 0);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator(".save-state").filter({ hasText: /^Saved$/ }).waitFor();
  const before = await page.evaluate(() => ({ ...window.editorWork }));
  assert.ok(before.compileProject > 0 && before.reviewTimeline > 0 && before.missingIntervalsFromTimeline > 0, "test build must instrument all work");
  await page.getByRole("button", { name: "Song details", exact: true }).click();
  await page.getByLabel("Song name", { exact: true }).fill("");
  await page.getByLabel("Song name", { exact: true }).pressSequentially("A long routine with responsive song details", { delay: 5 });
  await page.getByLabel("Performing artist").fill("Fixture artist");
  await page.getByLabel("Tags", { exact: true }).fill("first, second, ");
  assert.equal(await page.getByLabel("Tags", { exact: true }).inputValue(), "first, second, ");
  await page.getByLabel("Tags", { exact: true }).blur();
  assert.equal(await page.getByLabel("Tags", { exact: true }).inputValue(), "first, second");
  await page.getByLabel("Stage", { exact: true }).selectOption("club");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator(".save-state").filter({ hasText: /^Saved$/ }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.editorWork), before, "metadata typing and save acknowledgements must not recompile or analyze poses");
  const saved = await store.project(projectId);
  assert.deepEqual(saved.metadata.tags, ["first", "second"]);
  assert.equal(saved.metadata.stage, "club");
  await page.getByLabel("Performing artist").fill("Autosaved artist");
  await page.locator(".save-state").filter({ hasText: /^Saved$/ }).waitFor();
  assert.equal((await store.project(projectId)).metadata.artist, "Autosaved artist");
  assert.deepEqual(await page.evaluate(() => window.editorWork), before);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: `View take: ${takeName}`, exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Record new take", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Camera setup", exact: true }).count(), 0);
  assert.equal(await page.getByLabel("Playable range on timeline").count(), 0);
  assert.match(await page.locator(".playable-readout").innerText(), /Song playable/);
  const paints = await page.evaluate(() => window.metadataPaints);
  paints.sort((a, b) => a - b);
  console.log(`Metadata input-to-animation-frame p95: ${paints[Math.floor(paints.length * .95)]?.toFixed(1)} ms (${paints.length} input events).`);
  await page.reload();
  await page.getByRole("heading", { name: "Preview", exact: true }).waitFor();
  const reopened = await store.project(projectId);
  assert.equal(reopened.playableStartMs, saved.playableStartMs);
  assert.equal(reopened.playableEndMs, saved.playableEndMs);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log("Editor regression passed: dedicated panels, shared track selection, playable bounds, and zero pose work while typing/saving/autosaving metadata on a 3-minute routine with 121 history entries.");
} finally {
  await browser.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await dispose(); await rm(directory, { recursive: true, force: true });
}

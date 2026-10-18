// Test-only bridge into the same browser storage used by the built static app.
// The HTTP server serves files and rejects /api; it has no project backend.
import express from "express";
import { build } from "vite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import type * as Api from "../web/api.ts";
import type { Project, ProjectV3, Take } from "../core.ts";

export async function staticStudio(studioRoot = "tools/choreography/dist") {
  const directory = await mkdtemp(path.join(tmpdir(), "studio-static-test-"));
  await build({ configFile: false, logLevel: "error", build: {
    outDir: directory, target: "esnext", minify: false,
    lib: { entry: path.resolve("tools/choreography/web/api.ts"), formats: ["es"], fileName: () => "storage.js" },
  } });
  const app = express();
  app.get("/__test__/empty.html", (_req, res) => res.type("html").send("<!doctype html><title>Storage fixture</title>"));
  app.get("/__test__/storage.js", (_req, res) => res.sendFile(path.join(directory, "storage.js")));
  app.use("/api", (_req, res) => res.status(404).end());
  app.use(express.static(studioRoot));
  return { app, dispose: () => rm(directory, { recursive: true, force: true }) };
}

export function browserStore(page: Page) {
  async function call<T>(method: string, args: unknown[]): Promise<T> {
    return page.evaluate(async ({ method, args }) => {
      const url = "/__test__/storage.js", { workspace }: typeof Api = await import(url);
      const fn: unknown = Reflect.get(workspace, method);
      if (typeof fn !== "function") throw Error("Unknown storage method");
      return fn.apply(workspace, args);
    }, { method, args });
  }
  return {
    location: (projectId: string, ...parts: string[]) => ["projects", projectId, ...parts].join("/"),
    project: (projectId: string) => call<Project>("project", [projectId]),
    open: (projectId: string) => call<ProjectV3>("open", [projectId]),
    list: () => call<Awaited<ReturnType<(typeof Api)["workspace"]["list"]>>>("list", []),
    save: (p: Project, expected: unknown) => call<Project>("save", [p, expected]),
    read: (projectId: string, ...parts: string[]) => call<unknown>("read", [projectId, ...parts]),
    /** A take with its project summary's metadata, decoded from takes/<takeId>.adpose. */
    take: (projectId: string, takeId: string) => call<unknown>("takeById", [projectId, takeId]),
    /** A track snapshot decoded from tracks/<dataId>.adpose. */
    track: (projectId: string, dataId: string) => call<unknown>("track", [projectId, dataId]),
    writeTake: (projectId: string, take: Take) => call<Take>("writeTake", [projectId, take]),
    writeTrack: (projectId: string, data: unknown) => call<{ dataId: string }>("writeTrack", [projectId, data]),
    remove: (projectId: string, revision: number, takeId?: string) => call("remove", [projectId, revision, takeId]),
    async atomic(filename: string, bytes: Uint8Array) {
      await page.evaluate(async ({ filename, bytes }) => {
        const url = "/__test__/storage.js", { workspace }: typeof Api = await import(url);
        await workspace.atomic(filename, new Uint8Array(bytes));
      }, { filename, bytes: Array.from(bytes) });
    },
    async erase(prefix: string) {
      await page.evaluate(async prefix => {
        const url = "/__test__/storage.js", { workspace }: typeof Api = await import(url);
        await workspace.files.commit(new Map(), [prefix]);
      }, prefix);
    },
    async bytes(filename: string) {
      return new Uint8Array(await page.evaluate(async filename => {
        const url = "/__test__/storage.js", { workspace }: typeof Api = await import(url);
        return Array.from(await workspace.files.read(filename));
      }, filename));
    },
    async restore(archive: Uint8Array) {
      return page.evaluate(async bytes => {
        const url = "/__test__/storage.js", { workspace }: typeof Api = await import(url);
        return workspace.restore(Uint8Array.from(atob(bytes), c => c.charCodeAt(0)));
      }, Buffer.from(archive).toString("base64"));
    },
    async download(projectId: string, kind: "backup" | "export") {
      return Buffer.from(await page.evaluate(async ({ projectId, kind }) => {
        const url = "/__test__/storage.js", { workspace }: typeof Api = await import(url);
        const bytes = await workspace.download(projectId, kind), chunks: string[] = [];
        for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
        return btoa(chunks.join(""));
      }, { projectId, kind }), "base64");
    },
  };
}

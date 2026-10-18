// Shared by the Dance Studio tests (not a test file itself).
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { Locator } from "playwright";
import { isObject } from "../../../packages/pose/choreography.ts";
import type { TrackCalibration } from "../../../packages/pose/choreography.ts";
import { decodePoseFile } from "../../../packages/pose/binary.ts";
import { validateProject, validateTake } from "../core.ts";
import type { ProjectV2 } from "../core.ts";

/** Waits for a locator to match exactly `count` elements: the UI renders after the action that triggers it. */
export async function expectCount(locator: Locator, count: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let actual = await locator.count();
  while (actual !== count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    actual = await locator.count();
  }
  assert.equal(actual, count);
}

/** The value, failing the test when it is missing. */
export function found<T>(value: T | null | undefined): T {
  assert.ok(value != null);
  return value;
}
/** The value at a path inside untrusted JSON, or undefined. */
export function read(value: unknown, ...keys: (string | number)[]): unknown {
  for (const key of keys) value = isObject(value) ? value[key] : undefined;
  return value;
}
/** A test double for a DOM or platform type: only the members the code under test uses are provided. */
export const fake = <T>(value: object) => value as T;

/** The origin of a server listening on 127.0.0.1. */
export function baseUrl(server: Server): string {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
/** A project the API returned; the server always returns format 2. */
export async function projectOf(response: Response): Promise<ProjectV2> {
  const p = validateProject(await response.json());
  assert.ok(p.schemaVersion === 2);
  return p;
}
export const takeOf = async (response: Response) => validateTake(await response.json());
/** A JSON file from an exported ZIP. */
export const zipJson = (files: ReadonlyMap<string, Buffer>, name: string): unknown => JSON.parse(found(files.get(name)).toString());
/** An .adpose file from an exported ZIP, decoded. */
export const zipPose = (files: ReadonlyMap<string, Buffer>, name: string) => decodePoseFile(found(files.get(name)));
/** A calibration as a pose file stores it: its measurements are f32. */
export const storedCalibration = (c: TrackCalibration): TrackCalibration => ({ ...c, torsoLength: Math.fround(c.torsoLength), floorY: Math.fround(c.floorY),
  baseHip: { x: Math.fround(c.baseHip.x), y: Math.fround(c.baseHip.y), z: Math.fround(c.baseHip.z) },
  ...(c.bodyTorsoLength === undefined ? {} : { bodyTorsoLength: Math.fround(c.bodyTorsoLength) }) });

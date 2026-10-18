import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { makeZip, readZip } from "../storage/zip.ts";
import { makeZip as legacyZip, readZip as legacyRead } from "../server/zip.ts";

function deflated(data: Uint8Array, declaredSize = data.length) {
  const zip = Buffer.from(makeZip(new Map([["project.json", data]]))), compressed = deflateRawSync(data);
  const localLength = 30 + zip.readUInt16LE(26), centralOffset = zip.readUInt32LE(zip.length - 6);
  const local = Buffer.from(zip.subarray(0, localLength)), central = Buffer.from(zip.subarray(centralOffset, zip.length - 22)), end = Buffer.from(zip.subarray(-22));
  local.writeUInt16LE(8, 8); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(declaredSize, 22);
  central.writeUInt16LE(8, 10); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(declaredSize, 24);
  end.writeUInt32LE(localLength + compressed.length, 16);
  return Buffer.concat([local, compressed, central, end]);
}
test("portable ZIP export exactly matches existing backups and accepts compressed imports", async () => {
  const files = new Map([["project.json", new TextEncoder().encode('{"name":"Dance 🎵"}')], ["assets/audio.wav", new Uint8Array([0, 255, 1])]]);
  const zip = makeZip(files);
  assert.deepEqual(Buffer.from(zip), legacyZip(files));
  assert.deepEqual([...await readZip(zip)].map(([name, bytes]) => [name, [...bytes]]), [...files].map(([name, bytes]) => [name, [...bytes]]));
  assert.equal(legacyRead(Buffer.from(zip)).size, files.size);
  const content = new TextEncoder().encode("long repeated recording ".repeat(10000));
  const restored = await readZip(deflated(content));
  assert.deepEqual(restored.get("project.json"), content);
});
test("portable imports bound decompression and reject unsafe, corrupt, or truncated archives", async () => {
  const content = new TextEncoder().encode("x".repeat(100000));
  await assert.rejects(readZip(deflated(content, 1)), /expanded limit/);
  await assert.rejects(readZip(deflated(content), 1000), /expanded limit/);
  assert.throws(() => makeZip(new Map([["../project.json", content]])), /Unsafe/);
  const corrupt = makeZip(new Map([["project.json", content]]));
  corrupt[45] ^= 1;
  await assert.rejects(readZip(corrupt), /checksum/);
  for (const end of [0, 4, 21, 30, corrupt.length - 1]) await assert.rejects(readZip(corrupt.subarray(0, end)));
});

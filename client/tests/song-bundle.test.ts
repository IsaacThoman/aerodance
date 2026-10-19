import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCatalog, validateBundlePath, validateSongChoreography, sampleSong } from '../../packages/pose/song.ts';
import { isArray, isObject } from '../../packages/pose/choreography.ts';
import { loadSongBundle, sha256 } from '../src/songs/loadBundle.ts';
import type { Fetcher } from '../src/songs/loadBundle.ts';
import { bundleFixture } from './fixtures/songBundle.ts';
import type { BundleFixture } from './fixtures/songBundle.ts';
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const file = (files: Map<string, Uint8Array<ArrayBuffer>>, name: string) => {
  const data = files.get(name);
  assert.ok(data, `fixture file ${name}`);
  return data;
};
async function server(fixture = bundleFixture()) {
  const files = new Map([['song.json',bytes(fixture.song)],['choreography.json',bytes(fixture.choreography)],['audio.wav',fixture.audio]]);
  const checksums = {schema:'aerodance.checksums',schemaVersion:1,files:await Promise.all([...files].map(async ([path,data])=>({path,bytes:data.length,sha256:await sha256(data)})))};
  files.set('checksums.json',bytes(checksums));
  const requests: URL[] = [];
  const fetcher: Fetcher = async (url,{signal}={}) => {
    signal?.throwIfAborted(); requests.push(new URL(url));
    const file = files.get(new URL(url).pathname.split('/').at(-1) ?? '');
    return new Response(file ?? '',{status:file ? 200 : 404});
  };
  return {files,fetcher,requests,fixture};
}
test('loads pinned bundle bytes, verifies integrity and selects track 0 in one player mode',async()=>{
  const {fixture,fetcher,requests} = await server();
  validateCatalog({version:1,songs:[fixture.entry]});
  const loaded = await loadSongBundle(fixture.entry,'https://game.test/songs/manifest.json',{fetcher});
  assert.equal(loaded.audio.size,fixture.audio.length);
  assert.ok(requests.every(url=>url.searchParams.get('revision')==='1'));
  const one = sampleSong(loaded,200,1), two = sampleSong(loaded,200,2);
  assert.equal(one.poses.length,1); assert.deepEqual(one.poses[0],two.poses[0]);
  for (const time of [99,900,1200]) assert.deepEqual(sampleSong(loaded,time,2).poses,[]);
  assert.ok(sampleSong(loaded,350,1).quality[0].scoreEligible.every(v=>!v));
  assert.ok(sampleSong(loaded,400,1).quality[0].scoreEligible.some(Boolean));
});
test('three and four players dance the parts of the duet again, with their own ids and exclusions',()=>{
  const bundle = bundleFixture();
  const two = sampleSong(bundle,200,2), four = sampleSong(bundle,200,4), three = sampleSong(bundle,200,3);
  assert.deepEqual(four.poses.map(p=>p.playerId),[0,1,2,3]);
  assert.deepEqual(four.quality.map(q=>q.playerId),[0,1,2,3]);
  assert.deepEqual(four.poses[2].landmarks,two.poses[0].landmarks); assert.deepEqual(four.poses[3].landmarks,two.poses[1].landmarks);
  assert.notEqual(four.poses[2].landmarks,four.poses[0].landmarks);
  assert.deepEqual(three.poses.map(p=>p.playerId),[0,1,2]);
  assert.ok(sampleSong(bundle,350,4).quality.every(q=>q.scoreEligible.every(v=>!v)));
  assert.ok(sampleSong(bundle,400,4).quality.every(q=>q.scoreEligible.some(Boolean)));
  // A missing part is missing for everyone who dances it.
  bundle.choreography.samples[1].poses = [bundle.choreography.samples[1].poses[1]];
  bundle.choreography.samples[1].quality = [bundle.choreography.samples[1].quality[1]];
  assert.deepEqual(sampleSong(bundle,300,4).poses.map(p=>p.playerId),[1,3]);
});
test('songs list every player count from one up to four',()=>{
  const {entry} = bundleFixture();
  for (const counts of [[1,2],[1,2,3],[1,2,3,4]]) validateCatalog({version:1,songs:[{...entry,supportedPlayerCounts:counts}]});
  for (const counts of [[1],[2,1],[1,3],[1,2,3,4,5],[1,2,4]]) assert.throws(()=>validateCatalog({version:1,songs:[{...entry,supportedPlayerCounts:counts}]}));
});
test('absence and long gaps cannot become frozen or interpolated players',()=>{
  const bundle = bundleFixture();
  bundle.choreography.samples[1].poses = [bundle.choreography.samples[1].poses[1]];
  bundle.choreography.samples[1].quality = [bundle.choreography.samples[1].quality[1]];
  assert.deepEqual(sampleSong(bundle,200,1).poses,[]);
  assert.equal(sampleSong(bundle,300,2).poses[0].playerId,1);
  bundle.choreography.samples.splice(1,1);
  assert.deepEqual(sampleSong(bundle,250,2).poses,[]);
});
test('rejects corrupted audio, missing checksums, revision mismatches and catalog hash mismatches',async()=>{
  let s = await server(); file(s.files,'audio.wav')[50] ^= 1;
  await assert.rejects(loadSongBundle(s.fixture.entry,'https://game.test/songs/manifest.json',{fetcher:s.fetcher}),/integrity/);
  s = await server(); const manifest: unknown = JSON.parse(new TextDecoder().decode(file(s.files,'checksums.json')));
  assert.ok(isObject(manifest) && isArray(manifest.files)); manifest.files.pop();s.files.set('checksums.json',bytes(manifest));
  await assert.rejects(loadSongBundle(s.fixture.entry,'https://game.test/songs/manifest.json',{fetcher:s.fetcher}),/Missing/);
  s = await server();
  await assert.rejects(loadSongBundle({...s.fixture.entry,bundleRevision:2},'https://game.test/songs/manifest.json',{fetcher:s.fetcher}),/revision mismatch/);
  await assert.rejects(loadSongBundle({...s.fixture.entry,sha256:'0'.repeat(64)},'https://game.test/songs/manifest.json',{fetcher:s.fetcher}),/hash mismatch/);
});
test('validates file schemas, bounds, calibration, quality and safe relative paths',()=>{
  for (const path of ['../x','/x','a//b','https://example.com/a','a?b','a\\b','%2e%2e/x','./x']) assert.throws(()=>validateBundlePath(path));
  const mutations: ((b: BundleFixture) => unknown)[] = [b=>b.choreography.songId='other',b=>b.song.playableEndMs=1100,b=>b.choreography.tracks[1].playerId=0,b=>b.choreography.samples[0].poses[0].landmarks[0].visibility=2,b=>b.choreography.samples[0].quality=[],b=>b.choreography.tracks[0].calibration.torsoLength=0];
  for (const mutate of mutations) {
    const b=bundleFixture();mutate(b);assert.throws(()=>validateSongChoreography(b.song,b.choreography));
  }
});
test('cancellation prevents loading the bundle',async()=>{
  const {fixture,fetcher}=await server();const c=new AbortController();c.abort();
  await assert.rejects(loadSongBundle(fixture.entry,'https://game.test/songs/manifest.json',{fetcher,signal:c.signal}),{name:'AbortError'});
});

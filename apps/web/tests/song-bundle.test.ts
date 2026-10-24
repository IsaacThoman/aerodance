import test from 'node:test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { defaultCast, isCast, leadOf, sha256, validateCatalog, validateBundlePath, validateSong, validateSongChoreography, sampleDancers, sampleSong } from '../../../packages/pose/song.ts';
import { isArray, isObject } from '../../../packages/pose/choreography.ts';
import { loadSongBundle } from '../src/songs/loadBundle.ts';
import type { Fetcher } from '../src/songs/loadBundle.ts';
import { bundleFixture, choreographyBytes } from './fixtures/songBundle.ts';
import type { BundleFixture } from './fixtures/songBundle.ts';
import { encodePoseFile } from '../../../packages/pose/binary.ts';
import { songChoreographyFromTimeline } from '../../../packages/pose/song.ts';
// Players taking a duet's dancers in turn.
const turns = (players: number) => defaultCast(players, 2);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const file = (files: Map<string, Uint8Array<ArrayBuffer>>, name: string) => {
  const data = files.get(name);
  assert.ok(data, `fixture file ${name}`);
  return data;
};
async function server(fixture = bundleFixture()) {
  const files = new Map([['song.json',bytes(fixture.song)],['choreography.adpose',choreographyBytes(fixture)],['audio.wav',fixture.audio]]);
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
  const one = sampleSong(loaded,200,turns(1)), two = sampleSong(loaded,200,turns(2));
  assert.equal(one.poses.length,1); assert.deepEqual(one.poses[0],two.poses[0]);
  for (const time of [99,900,1200]) assert.deepEqual(sampleSong(loaded,time,turns(2)).poses,[]);
  assert.ok(sampleSong(loaded,350,turns(1)).quality[0].scoreEligible.every(v=>!v));
  assert.ok(sampleSong(loaded,400,turns(1)).quality[0].scoreEligible.some(Boolean));
});
const decoded = (b: BundleFixture) => ({ song: b.song, choreography: validateSongChoreography(b.song, choreographyBytes(b)) });
/** The fixture as a schema 1 choreography.json, still read for one release. */
function legacyJson(b: BundleFixture) {
  b.song.choreography = { path: 'choreography.json', schemaVersion: 1 };
  return bytes(b.choreography);
}
test('absence and long gaps cannot become frozen or interpolated players',()=>{
  const bundle = bundleFixture();
  bundle.choreography.samples[1].poses = [bundle.choreography.samples[1].poses[1]];
  bundle.choreography.samples[1].quality = [bundle.choreography.samples[1].quality[1]];
  assert.deepEqual(sampleSong(decoded(bundle),200,turns(1)).poses,[]);
  assert.equal(sampleSong(decoded(bundle),300,turns(2)).poses[0].playerId,1);
  bundle.choreography.samples.splice(1,1);
  assert.deepEqual(sampleSong(decoded(bundle),250,turns(2)).poses,[]);
});
test('three and four players take a duet\'s dancers in turn, with their own ids and exclusions',()=>{
  const bundle = bundleFixture(), song = decoded(bundle);
  const two = sampleSong(song,200,turns(2)), four = sampleSong(song,200,turns(4)), three = sampleSong(song,200,turns(3));
  assert.deepEqual(four.poses.map(p=>p.playerId),[0,1,2,3]);
  assert.deepEqual(four.quality.map(q=>q.playerId),[0,1,2,3]);
  assert.deepEqual(four.poses[2].landmarks,two.poses[0].landmarks); assert.deepEqual(four.poses[3].landmarks,two.poses[1].landmarks);
  assert.notEqual(four.poses[2].landmarks,four.poses[0].landmarks);
  assert.deepEqual(three.poses.map(p=>p.playerId),[0,1,2]);
  assert.ok(sampleSong(song,350,turns(4)).quality.every(q=>q.scoreEligible.every(v=>!v)));
  assert.ok(sampleSong(song,400,turns(4)).quality.every(q=>q.scoreEligible.some(Boolean)));
  // Each part's exclusions follow everyone who dances it.
  const parts = bundleFixture();
  parts.choreography.tracks[1].unscorableIntervals = [{startMs:500,endMs:600,reason:'Part 2 only'}];
  const excluded = (t: number) => sampleSong(decoded(parts),t,turns(4)).quality.map(q=>q.scoreEligible.every(v=>!v));
  assert.deepEqual(excluded(350),[true,false,true,false]);
  assert.deepEqual(excluded(550),[false,true,false,true]);
  // A missing part is missing for everyone who dances it.
  bundle.choreography.samples[1].poses = [bundle.choreography.samples[1].poses[1]];
  bundle.choreography.samples[1].quality = [bundle.choreography.samples[1].quality[1]];
  assert.deepEqual(sampleSong(decoded(bundle),300,turns(4)).poses.map(p=>p.playerId),[1,3]);
});
test('a song has one to four dancers, and says so in song.json and the catalog',()=>{
  for (const dancers of [1,2,3,4] as const) {
    const fixture = bundleFixture({dancers}), song = decoded(fixture);
    assert.equal(song.choreography.tracks.length,dancers);
    assert.equal(song.choreography.playerSlots,dancers);
    assert.deepEqual(sampleDancers(song,200).poses.map(p=>p.playerId),Array.from({length:dancers},(_,i)=>i));
    validateCatalog({version:1,songs:[fixture.entry]});
    // The schema 1 JSON choreography holds them too.
    const legacy = bundleFixture({dancers});
    assert.equal(validateSongChoreography(legacy.song,legacyJson(legacy)).tracks.length,dancers);
  }
  // Songs published before it are duets.
  const duet = bundleFixture();
  assert.equal(duet.song.dancers,undefined);
  assert.equal(decoded(duet).choreography.tracks.length,2);
  // song.json and the choreography must agree.
  const four = bundleFixture({dancers:4});
  assert.throws(()=>validateSongChoreography({...four.song,dancers:3},choreographyBytes(four)),/dancers mismatch/);
  assert.throws(()=>validateSongChoreography({...four.song,dancers:undefined},choreographyBytes(four)),/dancers mismatch/);
  const trio = bundleFixture({dancers:3}), trioJson = legacyJson(trio);
  assert.throws(()=>validateSongChoreography({...trio.song,dancers:undefined},trioJson),/dancers mismatch/);
  for (const dancers of [0,5,1.5,'2',null]) {
    assert.throws(()=>validateSong({...four.song,dancers}),/one to four dancers/);
    assert.throws(()=>validateCatalog({version:1,songs:[{...four.entry,dancers}]}));
  }
  // A choreography's tracks are its dancers, in order.
  const shuffled = bundleFixture({dancers:3});
  shuffled.choreography.tracks.reverse();
  assert.throws(()=>validateSongChoreography(shuffled.song,legacyJson(shuffled)),/ordered dancer tracks/);
  const five = bundleFixture({dancers:4});
  five.choreography.tracks.push({...five.choreography.tracks[3],playerId:4});
  assert.throws(()=>encodePoseFile(songChoreographyFromTimeline(five.choreography)),/player slots must be 1 to 4/);
});
test('each player follows the dancer their cast picks, sharing dancers and leaving some to dance alone',()=>{
  const crew = decoded(bundleFixture({dancers:4}));
  // Two players on the third and fourth dancers.
  const picked = sampleSong(crew,200,[2,3]), all = sampleDancers(crew,200);
  assert.deepEqual(picked.poses.map(p=>p.playerId),[0,1]);
  assert.deepEqual(picked.poses[0].landmarks,all.poses[2].landmarks);
  assert.deepEqual(picked.poses[1].landmarks,all.poses[3].landmarks);
  // Three players sharing one dancer get their own copies.
  const shared = sampleSong(crew,200,[1,1,1]);
  assert.deepEqual(shared.quality.map(q=>q.playerId),[0,1,2]);
  assert.notEqual(shared.poses[0].landmarks,shared.poses[1].landmarks);
  assert.deepEqual(shared.poses[2].landmarks,all.poses[1].landmarks);
  // A dancer's exclusions follow whoever follows them.
  const parts = bundleFixture({dancers:3});
  parts.choreography.tracks[2].unscorableIntervals = [{startMs:500,endMs:600,reason:'Dancer 3 only'}];
  const excluded = sampleSong(decoded(parts),550,[2,0]).quality.map(q=>q.scoreEligible.every(v=>!v));
  assert.deepEqual(excluded,[true,false]);
  // A cast must give every player one of the song's dancers.
  for (const cast of [[],[0,4],[0,-1],[0.5],[0,0,0,0,0]]) assert.throws(()=>sampleSong(crew,200,cast),/Invalid cast/);
  // Nobody choosing: players take the dancers in turn.
  assert.deepEqual(defaultCast(4,1),[0,0,0,0]);
  assert.deepEqual(defaultCast(3,2),[0,1,0]);
  assert.deepEqual(defaultCast(2,4),[0,1]);
  assert.ok(isCast([3,0],2,4) && !isCast([3,0],2,3) && !isCast([0],2,2) && !isCast('01',2,2));
  // A dancer wears the colour of the first player following them.
  assert.deepEqual([0,1,2,3].map(d=>leadOf([2,0,2],d)),[1,-1,0,-1]);
});
test('songs list every player count from one up to four',()=>{
  const {entry} = bundleFixture();
  for (const counts of [[1,2],[1,2,3],[1,2,3,4]]) validateCatalog({version:1,songs:[{...entry,supportedPlayerCounts:counts}]});
  for (const counts of [[1],[2,1],[1,3],[1,2,3,4,5],[1,2,4]]) assert.throws(()=>validateCatalog({version:1,songs:[{...entry,supportedPlayerCounts:counts}]}));
});
test('a schema 1 JSON choreography loads into the same frames as its binary export',()=>{
  const binary = decoded(bundleFixture()), legacy = bundleFixture();
  const json = { song: legacy.song, choreography: validateSongChoreography(legacy.song, legacyJson(legacy)) };
  for (const t of [100,200,350,650,899]) assert.deepEqual(sampleSong(json,t,turns(2)),sampleSong(binary,t,turns(2)));
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
  const mutations: ((b: BundleFixture) => unknown)[] = [b=>b.choreography.songId='other',b=>b.song.playableEndMs=1100,b=>b.choreography.tracks[1].playerId=0,b=>b.choreography.samples[0].poses[0].landmarks[0].confidence=2,b=>b.choreography.samples[0].quality=[],b=>b.choreography.tracks[0].calibration.torsoLength=0];
  for (const mutate of mutations) {
    const b=bundleFixture();mutate(b);assert.throws(()=>validateSongChoreography(b.song,legacyJson(b)));
  }
  const binaryMutations: ((b: BundleFixture) => unknown)[] = [b=>b.choreography.songId='other',b=>b.song.playableEndMs=800,b=>b.choreography.tracks[0].calibration.torsoLength=0,b=>b.choreography.tracks[1].unscorableIntervals[0].reason=''];
  for (const mutate of binaryMutations) {
    const b=bundleFixture();mutate(b);assert.throws(()=>validateSongChoreography(b.song,choreographyBytes(b)));
  }
  const b=bundleFixture(), corrupt=choreographyBytes(b); corrupt[3]^=1;
  assert.throws(()=>validateSongChoreography(b.song,corrupt),/not an .adpose/);
});
test('cancellation prevents loading the bundle',async()=>{
  const {fixture,fetcher}=await server();const c=new AbortController();c.abort();
  await assert.rejects(loadSongBundle(fixture.entry,'https://game.test/songs/manifest.json',{fetcher,signal:c.signal}),{name:'AbortError'});
});
test('the shipped demo choreography is a compact binary file that samples both dancers',async()=>{
  const dir = new URL('../public/songs/demo-track-1/', import.meta.url);
  const song = validateSong(JSON.parse(await readFile(new URL('song.json', dir), 'utf8')));
  const bytes = await readFile(new URL(song.choreography.path, dir));
  assert.equal(song.choreography.schemaVersion, 2);
  assert.ok(bytes.length < 200 * 1024, `${bytes.length} bytes`);
  const bundle = { song, choreography: validateSongChoreography(song, bytes) };
  assert.equal(bundle.choreography.jointFlags, null);
  assert.deepEqual(sampleSong(bundle,15000,turns(2)).poses.map(p => p.playerId), [0, 1]);
});

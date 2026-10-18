import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { migrateLegacyMotion, validateMotionTake } from '../../packages/pose/legacy.ts';
import { decodeMotion, encodeMotion } from '../../packages/pose/motion.ts';
import { decodePoseFile } from '../../packages/pose/binary.ts';
type Legacy = ReturnType<typeof legacy>;
const legacy = () => ({version:1,duration:1,source:{width:640,height:480,sha256:'source'},times:[0,.5],poses:Array.from({length:2},()=>Array.from({length:2},()=>Array.from({length:33},()=>[1.1,.5,-.2,.75])))});
test('legacy migration preserves timing, IDs and out-of-image coordinates without inventing confidence or scores',()=>{
  const data=legacy(),take=migrateLegacyMotion(data);
  assert.equal(validateMotionTake(take),take);
  assert.equal(take.samples[1].takeTimeMs,500);
  assert.deepEqual(take.samples[0].poses.map(p=>p.playerId),[0,1]);
  assert.deepEqual(take.samples[0].poses[1].landmarks[0],{x:1.1,y:.5,z:-.2,confidence:null});
  assert.ok(take.samples[0].quality.every(q=>q.scoreEligible.every(v=>!v)));
  assert.equal(take.provenance.source.sha256,'source'); assert.equal(data.version,1);
  assert.ok(!('seq' in take.samples[0]));
});
test('legacy import rejects invalid tuples, timestamps, IDs and confidence',()=>{
  const mutations: ((d: Legacy) => unknown)[] = [d=>d.times[1]=0,d=>d.poses[1].pop(),d=>d.poses[0][0][0][3]=1.1,d=>d.poses[0][0][0][0]=Infinity];
  for (const mutate of mutations) {
    const data=legacy(); mutate(data); assert.throws(()=>migrateLegacyMotion(data));
  }
});
test('committed demo is a take file of the migrated capture, with unknown confidence and its 14 s loop',async()=>{
  const bytes=await readFile(new URL('../../packages/character/assets/dance.adpose',import.meta.url));
  const data=decodeMotion(bytes);
  assert.ok(bytes.length<250_000,`${bytes.length} bytes`);
  assert.equal(data.samples.length,420);
  assert.equal(data.durationMs,14000);
  assert.equal(decodePoseFile(bytes).jointFlags,null,'every joint derives its flags from the null confidence');
  for (const sample of data.samples) {
    assert.equal(sample.poses.length,2);
    for (const pose of sample.poses) assert.ok(pose.landmarks.every(j=>j.confidence===null));
  }
  assert.deepEqual(decodeMotion(encodeMotion(data)),data,'re-encoding is stable');
});

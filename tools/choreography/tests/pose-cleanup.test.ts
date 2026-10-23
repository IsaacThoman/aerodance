import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupPoses, CLEANUP_SETTINGS } from '../poseCleanup.ts';
import { qualityFor } from '../../../packages/pose/choreography.ts';
import type { Pose } from '../../../packages/pose/choreography.ts';
import { newProject, addTake, overwriteTracks, cleanupTrack, historyStep, compileProject, validateTake, takeFromRecords } from '../core.ts';
import type { StudioAssets, Take } from '../core.ts';
import { encodeTake, decodeTake } from '../poseFiles.ts';
import { captureOf } from './helpers.ts';
import { poseModel, MEDIAPIPE_VERSION } from '../../../packages/pose/browser/models.ts';
import { selectVideoPose, fixedVideoCrop } from '../web/videoImport.ts';

const size={width:640,height:480};
function pose(playerId=0): Pose {
  const landmarks=Array.from({length:33},()=>({x:.7,y:.2,z:0,confidence:.95 as number|null}));
  for (const [j,x,y] of [[11,.6,.35],[12,.8,.35],[13,.5,.45],[14,.9,.45],[15,.4,.55],[16,.95,.55],[23,.65,.6],[24,.75,.6],[25,.64,.75],[26,.76,.75],[27,.63,.9],[28,.77,.9]]) landmarks[j]={x,y,z:0,confidence:.95};
  return {playerId,landmarks};
}
const frames=(n=31) => Array.from({length:n},(_,i)=>({takeTimeMs:i*1000/30,poses:[pose()],quality:qualityFor([pose()])}));
const joint=(s:ReturnType<typeof frames>[number],j=15)=>s.poses[0].landmarks[j];

test('centered cleanup halves stationary XY and depth noise without mutating timing, confidence or input',()=>{
  const samples=frames();
  samples.forEach((s,i)=>{joint(s).x+=(i%2 ? 1:-1)*.015; joint(s).z=(i%2 ? 1:-1)*.06;});
  const before=structuredClone(samples),result=cleanupPoses(samples,size);
  for (const axis of ['x','z'] as const) {
    const target=axis==='x'?.4:0;
    const rms=(data:typeof samples)=>Math.sqrt(data.slice(3,-3).reduce((sum,s)=>sum+(joint(s)[axis]-target)**2,0)/(data.length-6));
    assert.ok(rms(result.samples)<rms(samples)*.5,`${axis} noise reduction`);
  }
  assert.deepEqual(samples,before);
  assert.deepEqual(result.samples.map(s=>s.takeTimeMs),samples.map(s=>s.takeTimeMs));
  assert.ok(result.samples.every(s=>joint(s).confidence===.95));
  assert.equal(result.samples[15].quality[0].scoreEligible[15],true);
  assert.equal(result.samples[15].quality[0].landmarkOrigins[15],'edited');
});

test('cleanup reaches a crew song\'s third and fourth dancers, alone or with everyone',()=>{
  for (const id of [2,3]) {
    const samples=frames().map(s=>({...s,poses:[{...s.poses[0],playerId:id}],quality:[{...s.quality[0],playerId:id}]}));
    samples.forEach((s,i)=>{s.poses[0].landmarks[15].x+=(i%2 ? 1:-1)*.015;});
    for (const options of [{playerId:id},{}]) {
      const result=cleanupPoses(samples,size,options);
      assert.ok(result.counts.smoothedJoints>0,`P${id+1} smoothed`);
      assert.ok(Math.abs(result.samples[15].poses[0].landmarks[15].x-.4)<Math.abs(samples[15].poses[0].landmarks[15].x-.4));
    }
  }
});

test('isolated high-confidence wrist spikes and low-confidence ankle runs are repaired and unscorable',()=>{
  const samples=frames(); joint(samples[10]).x=1.2;
  for (const i of [15,16]) {joint(samples[i],27).confidence=.1; joint(samples[i],27).x=.1;}
  const {samples:cleaned,counts}=cleanupPoses(samples,size);
  assert.ok(Math.abs(joint(cleaned[10]).x-.4)<1e-10);
  assert.equal(joint(cleaned[10]).confidence,null);
  assert.equal(cleaned[10].quality[0].scoreEligible[15],false);
  assert.equal(cleaned[10].quality[0].landmarkOrigins[15],'gap-repaired');
  assert.ok(Math.abs(joint(cleaned[15],27).x-.63)<1e-10);
  assert.equal(counts.repairedJoints,3);
});

test('bounded pose gaps repair on existing timestamps; long and edge gaps remain absent',()=>{
  const samples=frames();
  for(const i of [0,1,8,9,15,16,17,18,19,20,21,30]) {samples[i].poses=[];samples[i].quality=[];}
  const result=cleanupPoses(samples,size);
  assert.equal(result.samples[8].poses.length,1);
  assert.equal(result.samples[8].quality[0].scoreEligible.some(Boolean),false);
  assert.equal(result.samples[8].poses[0].landmarks.every(p=>p.confidence===null),true);
  for(const i of [0,1,15,16,17,18,19,20,21,30]) assert.equal(result.samples[i].poses.length,0);
  assert.equal(result.counts.repairedGaps,1);
  assert.equal(result.counts.unresolvedGaps,3);
});

test('fast linear movement with variable intervals is preserved; sustained steps are not classified as spikes',()=>{
  const samples=frames(); let time=0;
  samples.forEach((s,i)=>{time+=i%2?25:40;s.takeTimeMs=time;joint(s).x=.1+time*.0007;});
  const result=cleanupPoses(samples,size);
  result.samples.forEach((s,i)=>assert.ok(Math.abs(joint(s).x-joint(samples[i]).x)<1/16384));
  const step=frames(); step.forEach((s,i)=>{if(i>=15)joint(s).x+=.3;});
  const cleaned=cleanupPoses(step,size);
  assert.equal(cleaned.counts.repairedJoints,0);
  assert.ok(Math.abs(joint(cleaned.samples[20]).x-.7)<1e-10);
});

test('cleanup respects selection, player isolation, exclusions and discontinuities',()=>{
  const samples=frames(); samples.forEach(s=>{s.poses.push(pose(1));s.quality=qualityFor(s.poses);s.quality[0].scoreEligible[15]=false;});
  joint(samples[10]).x=1.2; samples[10].poses[1].landmarks[15].x=1.2;
  const result=cleanupPoses(samples,size,{startMs:300,endMs:400,playerId:0});
  assert.equal(result.samples[10].poses[1].landmarks[15].x,1.2);
  for (let i=0;i<samples.length;i++) if(i<9 || i>=12) assert.deepEqual(result.samples[i],samples[i]);
  assert.equal(result.samples[10].quality[0].scoreEligible[15],false);
  const cut=frames(); cut.forEach((s,i)=>{if(i>=15)s.poses[0].landmarks.forEach(p=>{p.x-=.5;});});
  const cleaned=cleanupPoses(cut,size);
  assert.deepEqual(cleaned.samples,cut);
  const empty=frames(); empty[10].poses=[];empty[10].quality=[]; empty[11].poses[0].landmarks.forEach(p=>p.x-=.5);
  assert.equal(cleanupPoses(empty,size).samples[10].poses.length,0);
});

test('smooth-only excludes outliers without repairing them or filling gaps; unknown confidence remains ineligible',()=>{
  const samples=frames();joint(samples[10]).x=1.2; joint(samples[14]).confidence=null;
  samples[20].poses=[];samples[20].quality=[];
  const result=cleanupPoses(samples,size,{smoothOnly:true});
  assert.equal(joint(result.samples[10]).x,1.2);
  assert.equal(result.samples[10].quality[0].scoreEligible[15],false);
  assert.equal(result.samples[14].quality[0].scoreEligible[15],false);
  assert.equal(result.samples[20].poses.length,0);
  assert.equal(result.counts.repairedJoints,0);
});

test('unknown body scale preserves positions and reports unreliable joints, including partially selected gaps',()=>{
  const unknown=frames();
  unknown.forEach(s=>s.poses[0].landmarks.forEach(p=>p.confidence=null));
  const result=cleanupPoses(unknown,size);
  assert.deepEqual(result.samples.map(s=>s.poses),unknown.map(s=>s.poses));
  assert.equal(result.counts.unresolvedJoints,unknown.length*33);
  assert.equal(result.samples.some(s=>s.quality[0].scoreEligible.some(Boolean)),false);
  const samples=frames();
  for(let i=5;i<15;i++){samples[i].poses=[];samples[i].quality=[];}
  assert.equal(cleanupPoses(samples,size,{startMs:300,endMs:400}).counts.unresolvedGaps,1);
});

test('editor cleanup survives quantization, preserves exclusions and calibration, and undo/redo restores snapshots',()=>{
  const take:Take={schema:'aerodance.take',schemaVersion:1,takeId:'cleanup',name:'dance',source:'video',samples:frames(),input:{...size,mirrored:false},offsetMs:0,timeScale:1,
    calibrationFrame:{mediaTimeMs:0,poses:[pose()]}};
  joint(take.samples[10] as ReturnType<typeof frames>[number]).x=1.2;
  const assets:StudioAssets=new Map([[take.takeId,take]]);
  const before=overwriteTracks(addTake(newProject(),take),take,[0],assets);
  const result=cleanupTrack(before,assets,0,300,400);
  assert.ok(result.counts.repairedJoints>0);
  const data=assets.get(result.project.tracks[0].dataId!)!;
  assert.ok(data.schema==='aerodance.track');
  assert.equal(data.schema==='aerodance.track' && data.samples.some(s=>s.quality.some(q=>q.landmarkOrigins.includes('gap-repaired'))),true);
  assert.deepEqual(historyStep(result.project,-1).tracks,before.tracks);
  assert.deepEqual(historyStep(historyStep(result.project,-1),1).tracks,result.project.tracks);
  const compiled=compileProject(result.project,assets,{fullTimeline:true});
  assert.equal(compiled.samples.find(s=>Math.abs(s.songTimeMs-1000/3)<.001)!.quality[0].scoreEligible[15],false);
  const stored=decodeTake(encodeTake({...take,samples:cleanupPoses(take.samples,size).samples}),take);
  assert.equal(stored.samples[10].quality![0].landmarkOrigins[15],'gap-repaired');
  assert.equal(stored.samples[10].quality![0].scoreEligible[15],false);
});

test('video finalization opts in to cleanup, retains raw samples and legacy captures remain unprocessed',()=>{
  const model=poseModel('full'),samples=frames();joint(samples[10]).x=1.2;
  const records=samples.map((s,i)=>({ordinal:i,record:{seq:i+1,mediaTimeMs:s.takeTimeMs,poses:s.poses,
    sessionId:'cleanup',playerCount:2,input:size,modelId:model.id,timingMethod:'decoded-frame'}}));
  const capture=captureOf(records,'video',{mediaTimeMs:0,poses:[pose()]});
  const metadata={takeId:'video',sourceKind:'video',status:{modelId:model.id,modelHash:model.sha256,packageVersion:MEDIAPIPE_VERSION,delegate:'CPU',durationMs:1100,filename:'test.webm'}};
  const legacy=takeFromRecords(capture,metadata);
  assert.ok(legacy.samples[10].poses[0].landmarks[15].x>1);
  const result=takeFromRecords(capture,{...metadata,status:{...metadata.status,cleanup:{...CLEANUP_SETTINGS}}});
  assert.ok(Math.abs(result.samples[10].poses[0].landmarks[15].x-.4)<.001);
  assert.equal(result.samples[10].quality![0].scoreEligible[15],false);
  assert.ok(result.provenance?.cleanupCounts);
  assert.deepEqual(takeFromRecords(capture,{...metadata,status:{...metadata.status,cleanup:false}}).samples,legacy.samples);
  assert.equal(validateTake(result),result);
  assert.ok(takeFromRecords(capture,metadata).samples[10].poses[0].landmarks[15].x>1);
});

test('crop recovery checks continuity and never moves a detection to another slot',()=>{
  const good=pose(),bad=pose();bad.landmarks.forEach(p=>p.x-=.4);
  assert.equal(selectVideoPose(bad,good,{pose:good,time:0},33,4/3),good);
  assert.equal(selectVideoPose(good,bad,{pose:good,time:0},33,4/3),good);
  assert.equal(selectVideoPose(undefined,bad,{pose:good,time:0},33,4/3),undefined);
  assert.equal(selectVideoPose(undefined,bad,{pose:good,time:0},300,4/3),bad);
  assert.deepEqual(fixedVideoCrop([],0,640,480),{x:320,y:0,width:320,height:480});
  const crop=fixedVideoCrop([good],0,640,480);
  assert.equal(crop.x,320);assert.equal(crop.width,320);
  assert.ok(crop.y<=good.landmarks[11].y*480 && crop.y+crop.height>=good.landmarks[27].y*480);
});

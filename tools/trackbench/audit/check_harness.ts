/* eslint-disable @typescript-eslint/no-explicit-any -- a one-off audit check over loosely typed run files */
import {writeFileSync} from 'node:fs';
import {loadScene,readJsonl,danceWindow} from '../harness/common.ts';
import {referenceBundle,scoreRecords,gtLandmarks} from '../harness/score.ts';
import {GameSession} from '../../../apps/web/src/game/GameSession.ts';
import {GameLoop,toDetected} from '../harness/gameloop.ts';
import {expectedNumbering,detectionMetrics,trackedMetrics,zeroOffsets,accumulateOffsets,finishOffsets} from '../harness/metrics.ts';
import {buildReport,COLUMNS} from '../harness/report.ts';
const D='/Volumes/development/aerodance-trackbench'; const out:any={};
for(const sid of ['base-solo','sens-fps-15','mp2-cross-distinct','mot-floor']) {
 const scene=loadScene(sid), tracked:any[]=readJsonl(`${D}/runs/mp-lite-game/${sid}/tracked.jsonl`), mapping=expectedNumbering(scene,tracked).mapping, bundle=referenceBundle(scene,mapping,danceWindow(scene)!);
 const records=tracked.filter(r=>!r.dropped).map(r=>({captureMs:r.t_ms,receivedMs:r.received_ms,poses:r.poses.map((p:any)=>({playerId:p.playerId,landmarks:p.kp.map(([x,y,z,confidence]:any)=>({x,y,z,confidence}))}))}));
 let now=0; const session=new GameSession({bundle:bundle as any,playerCount:scene.players as any,now:()=>now,record:false,autoStart:false});
 session.phase='playing';session.player={state:'playing',ended:false,songTimeAt:(t:number)=>t} as any;
 let seq=0;for(const r of records){while(now+1000/60<r.receivedMs){now+=1000/60; session.scorer.advance(Math.min(now,bundle.song.playableEndMs)-750);} now=r.receivedMs;session.onRecord({record:{type:'pose',playerCount:scene.players,sessionId:'audit',seq:++seq,input:{width:scene.width,height:scene.height},poses:r.poses},captureBrowserTimeMs:r.captureMs} as any);}
 session.scorer.finish();const harness=scoreRecords(bundle,scene.players,records,scene.aspect).results;
 out[sid]={harness:harness.map(r=>r.score),gameSession:session.scorer.results().map(r=>r.score)};
}
const s=loadScene('base-solo'),det:any[]=readJsonl(`${D}/runs/rtmo-s/base-solo/detections.jsonl`);
const sums=zeroOffsets(); accumulateOffsets(s,det,sums);const fit=finishOffsets(sums);
out.selfFit={raw:detectionMetrics(s,det,null).keypoints.body,corrected:detectionMetrics(s,det,fit).keypoints.body};
// Synthetic fixed confident pose, gap after calibration: game's status clears it, GameLoop latches.
const p=s.gt.find(f=>f.people.some(p=>p.phase==='hold'))!.people[0]; const kp=p.kp.map(([x,y])=>[x,y,0,1]);const loop=new GameLoop(1,{width:s.width,height:s.height},{danceStartMs:10000});
for(let t=0;t<=3000;t+=100)loop.result(t/100+1,[toDetected(kp)],undefined,t,t);
const before=loop.calibrated;const r=loop.result(100,[toDetected(kp)],undefined,4000,4000);
out.calibrationGap={before,recordComplete:r.calib?.complete,actualStatus:loop.calibration.status(4000)};
// Delta is not pairwise when the common scene has a missing value.
const row=(estimator:string,scene:string,value:number|null)=>({estimator,scene,category:'audit',players:1,values:Object.fromEntries(COLUMNS.map(c=>[c.key,c.key==='calib'?value:0]))});
out.nullDelta=buildReport([row('base','a',1000),row('base','b',3000),row('candidate','a',null),row('candidate','b',3000)],'base').json.summary;
const empty=trackedMetrics(s,[{frame:181,t_ms:6000,received_ms:6600,poses:[],lined:false,dropped:true}],['p1']);out.droppedOnlyTracking=empty;
writeFileSync(`${D}/audit/harness-checks.json`,JSON.stringify(out,null,2));console.log(JSON.stringify(out,null,2));
for(const sid of ['cam-near-2.0','setup-too-close','mot-floor']) {
 const scene=loadScene(sid), mapping=expectedNumbering(scene,[]).mapping,b=referenceBundle(scene,mapping,danceWindow(scene)!);
 const make=(oracle:boolean)=>scene.gt.map(f=>({captureMs:f.t_ms,receivedMs:f.t_ms,poses:mapping.flatMap((id,playerId)=>{const p=f.people.find(p=>p.id===id);return p&&p.in_frame?[{playerId,landmarks:oracle?p.kp.map(([x,y])=>({x,y,z:0,confidence:1})):gtLandmarks(p)}]:[];})}));
 out[`ceiling-${sid}`]={gt:scoreRecords(b,mapping.length,make(false),scene.aspect).results.map(r=>r.score),oracle:scoreRecords(b,mapping.length,make(true),scene.aspect).results.map(r=>r.score)};
}
writeFileSync(`${D}/audit/harness-checks.json`,JSON.stringify(out,null,2)); console.log('Ceilings',Object.fromEntries(Object.entries(out).filter(([k])=>k.startsWith('ceiling'))));

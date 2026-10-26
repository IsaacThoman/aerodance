// Local-footage validation. Never copies source footage into tracked files.
// node tools/choreography/tests/video-quality.browser.ts /path/video.mp4 [output-directory]
// VALIDATION_GPU=1 enables local hardware inference. --reuse skips inference;
// --range=25:278 restricts additional metrics to an explicitly reviewed window.
import assert from 'node:assert/strict';
import express from 'express';
import path from 'node:path';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { captureHead, concatBytes, encodeTake } from '../poseFiles.ts';
import { decodePoseFile, framesToSamples } from '../../../packages/pose/binary.ts';
import { cleanupPoses } from '../poseCleanup.ts';
import { videoTakeFromRecords } from '../core.ts';
import { CONNECTIONS, JOINT_NAMES } from '../../../packages/pose/choreography.ts';
import type { Pose, FrameSize } from '../../../packages/pose/choreography.ts';
import type { CalibrationFrame, CaptureMetadata } from '../core.ts';
import type { CaptureStart } from '../poseFiles.ts';
import type * as VideoImport from '../web/videoImport.ts';
import { baseUrl } from './helpers.ts';

const source = path.resolve(process.argv[2] || '');
assert.ok(process.argv[2], 'Provide a local source video');
const output = path.resolve(process.argv[3] || '.cache/video-quality');
await mkdir(output, {recursive:true});
const vite=await createServer({root:path.resolve('.'),configFile:false,appType:'custom',logLevel:'warn',cacheDir:'.cache/video-quality-vite',
  server:{middlewareMode:true,ws:false},optimizeDeps:{include:['mediabunny']}});
const app=express();
app.get('/probe',(_req,res)=>res.type('html').send('<!doctype html><title>Pose quality validation</title>'));
app.get('/source',(_req,res)=>res.sendFile(source));
app.use(express.static('tools/choreography/dist'));app.use(vite.middlewares);
const server=app.listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
const workerFile=(await readdir('tools/choreography/dist/assets')).find(n=>n.startsWith('pose.worker-'));
assert.ok(workerFile,'Build the Studio first');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,args:['--no-sandbox','--use-gl=angle',
  process.env.VALIDATION_GPU==='1'?'--use-angle=gl':'--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-accelerated-video-decode']});
try {
  const page=await browser.newPage();
  page.on('pageerror',error=>console.error('Browser:',error.message));
  page.on('requestfailed',request=>console.error('Request failed:',request.url(),request.failure()?.errorText));
  page.setDefaultTimeout(60000);
  const batches:Uint8Array[]=[];
  await page.exposeFunction('qualityCapture',async(header:CaptureStart,status:unknown,calibration:CalibrationFrame|null)=>{
    await writeFile(path.join(output,'raw.partial.adpose'),captureHead(header,calibration ?? undefined));
    await writeFile(path.join(output,'capture.json'),JSON.stringify({header,status,calibration},null,2));
  });
  await page.exposeFunction('qualityBatch',async(bytes:number[])=>{const batch=new Uint8Array(bytes);batches.push(batch);await appendFile(path.join(output,'raw.partial.adpose'),batch);});
  await page.exposeFunction('qualityProgress',(message:string)=>console.log(message));
  await page.goto(`${baseUrl(server)}/probe`);
  const started=Date.now();
  const reuse=process.argv.includes('--reuse');
  const saved=reuse ? JSON.parse(await readFile(path.join(output,'capture.json'),'utf8')) as {header:CaptureStart;status:{durationMs:number};calibration:CalibrationFrame|null} : null;
  const result=saved ? { ...saved,width:saved.header.input.width,height:saved.header.input.height,durationMs:saved.status.durationMs,
    calibrationAttempts:saved.calibration ? [{time:saved.calibration.mediaTimeMs/1000,players:saved.calibration.poses.map(p=>p.playerId)}] : [] }
    : await page.evaluate(async(workerFile)=>{
    const sink=window as unknown as {qualityBatch:(bytes:number[])=>Promise<void>;qualityProgress:(message:string)=>Promise<void>;qualityCapture:(header:unknown,status:unknown,calibration:CalibrationFrame|null)=>Promise<void>};
    await sink.qualityProgress('Loading importer');
    const importerUrl='/tools/choreography/web/videoImport.ts';
    const {VideoImporter}:typeof VideoImport=await import(importerUrl);
    await sink.qualityProgress('Loading local video');
    const blob=await(await fetch('/source')).blob();
    const video=document.createElement('video');video.muted=true;video.preload='auto';
    const ready=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(`Source decoding timed out (readyState ${video.readyState})`)),30000);video.onloadeddata=()=>{clearTimeout(timer);resolve();};video.onerror=()=>{clearTimeout(timer);reject(Error('Source decoding failed'));};});
    video.src=URL.createObjectURL(blob);document.body.append(video);await ready;
    await sink.qualityProgress(`Video decoded: ${video.videoWidth}×${video.videoHeight}, ${video.duration.toFixed(2)} seconds`);
    let captureHeader:unknown,status:unknown;
    let lastProgress=-1;
    const job=new VideoImporter({video,file:blob,modelId:'lite',captureMode:'p1',projectId:'validation',cleanup:true,
      createWorker:()=>new Worker(`/assets/${workerFile}`,{type:'module'}),assetUrl:()=>`${location.origin}/pose-assets/mediapipe-1.1.0/`,
      onProgress:({fraction,message})=>{const step=Math.floor(fraction*100);if(step!==lastProgress){lastProgress=step;void sink.qualityProgress(`${step}% ${message}`);}},
      request:async(url,{body}={})=>{
        if(url.endsWith('/takes') && body && typeof body==='object'){captureHeader=Reflect.get(body,'header');status=Reflect.get(body,'status');await sink.qualityCapture(captureHeader,status,calibration);}
        if(url.includes('/batches') && body instanceof Uint8Array)await sink.qualityBatch(Array.from(body));
        return {takeId:'validation'};
      }});
    const calibrationAttempts:{time:number;players:number[];error?:string}[]=[];
    let calibration:CalibrationFrame|null=null;
    for(const time of [25,20,30,40,50]) {
      await sink.qualityProgress(`Checking calibration at ${time}s`);
      try {const frame=await job.calibrate(time);calibrationAttempts.push({time,players:frame.poses.map(p=>p.playerId)});if(frame.poses.length){calibration={mediaTimeMs:frame.mediaTimeMs,poses:frame.poses};break;}}
      catch(error){calibrationAttempts.push({time,players:[],error:String(error)});}
    }
    await job.process('local-validation.mp4');
    return {header:captureHeader as CaptureStart,status,calibration,calibrationAttempts,width:video.videoWidth,height:video.videoHeight,durationMs:video.duration*1000};
  },workerFile);
  const elapsedSeconds=reuse ? null : (Date.now()-started)/1000;
  const rawBytes=reuse ? new Uint8Array(await readFile(path.join(output,'raw.adpose'))) : concatBytes([captureHead(result.header,result.calibration ?? undefined),...batches]);
  await writeFile(path.join(output,'raw.adpose'),rawBytes);
  const capture=decodePoseFile(rawBytes),raw=framesToSamples(capture,'takeTimeMs');
  const size:FrameSize={width:result.width,height:result.height};
  const cleaned=cleanupPoses(raw,size);
  assert.deepEqual(cleaned.samples.map(s=>s.takeTimeMs),raw.map(s=>s.takeTimeMs));
  if(result.calibration) {
    const metadata:CaptureMetadata={takeId:'validation',sourceKind:'video',name:path.basename(source),status:result.status};
    const take=videoTakeFromRecords(capture,metadata);
    await writeFile(path.join(output,'cleaned.adpose'),encodeTake(take));
  }
  const median=(xs:number[])=>{const values=xs.toSorted((a,b)=>a-b);return values[Math.floor(values.length/2)] || 1;};
  const aspect=size.width/size.height;
  const hip=(p:Pose)=>({x:(p.landmarks[23].x+p.landmarks[24].x)/2,y:(p.landmarks[23].y+p.landmarks[24].y)/2});
  const scale=median(raw.flatMap(s=>s.poses.map(p=>{const h=hip(p);return Math.hypot((h.x-(p.landmarks[11].x+p.landmarks[12].x)/2)*aspect,h.y-(p.landmarks[11].y+p.landmarks[12].y)/2);})).filter(v=>v>.001));
  const joints=[11,12,13,14,15,16,23,24,25,26,27,28];
  const dist=(a:{x:number;y:number},b:{x:number;y:number})=>Math.hypot((a.x-b.x)*aspect,a.y-b.y)/scale;
  const measure=(samples:typeof raw,rangeEndMs=result.durationMs)=>{
    const residuals:{frame:number;timeMs:number;joint:number;residual:number;confidence:number|null}[]=[];
    const gaps:{startMs:number;endMs:number}[]=[];
    let start:number|null=null;
    for(let i=0;i<samples.length;i++) {
      const p=samples[i].poses[0];
      if(!p){start ??= samples[i].takeTimeMs;continue;}
      if(start!==null){gaps.push({startMs:start,endMs:samples[i].takeTimeMs});start=null;}
      const a=samples[i-1]?.poses[0],b=samples[i+1]?.poses[0];
      if(!a || !b)continue;
      const alpha=(samples[i].takeTimeMs-samples[i-1].takeTimeMs)/(samples[i+1].takeTimeMs-samples[i-1].takeTimeMs);
      for(const joint of joints){const x=a.landmarks[joint],y=p.landmarks[joint],z=b.landmarks[joint];residuals.push({frame:i,timeMs:samples[i].takeTimeMs,joint,
        residual:dist(y,{x:x.x+(z.x-x.x)*alpha,y:x.y+(z.y-x.y)*alpha}),confidence:y.confidence});}
    }
    if(start!==null)gaps.push({startMs:start,endMs:rangeEndMs});
    const values=residuals.map(r=>r.residual).toSorted((a,b)=>a-b);
    return {presentFrames:samples.filter(s=>s.poses.length).length,missingFrames:samples.filter(s=>!s.poses.length).length,gaps,
      residualP95:values[Math.floor(values.length*.95)],residualP99:values[Math.floor(values.length*.99)],
      residualAbovePointSix:residuals.filter(r=>r.residual>.6).length,worst:residuals.toSorted((a,b)=>b.residual-a.residual).slice(0,40),residuals};
  };
  const before=measure(raw),after=measure(cleaned.samples);
  assert.ok(after.presentFrames>=before.presentFrames,'Cleanup must not remove detected poses');
  for(const [i,sample] of cleaned.samples.entries())for(const pose of sample.poses) {
    const original=raw[i].poses.find(p=>p.playerId===pose.playerId),quality=sample.quality!.find(q=>q.playerId===pose.playerId)!;
    pose.landmarks.forEach((joint,j)=>{
      if(quality.landmarkOrigins[j]==='gap-repaired')assert.ok(joint.confidence===null && !quality.scoreEligible[j],'Repairs must require scoring review');
      else if(original)assert.equal(joint.confidence,original.landmarks[j].confidence,'Measured confidence must stay unchanged');
    });
  }
  const summarize=({residuals,...stats}:ReturnType<typeof measure>)=>{void residuals;return stats;};
  const range=process.argv.find(arg=>arg.startsWith('--range='))?.slice(8).split(':').map(Number);
  if(range)assert.ok(range.length===2 && range.every(Number.isFinite) && range[0]>=0 && range[1]>range[0],'Invalid review range');
  const windowStats=range ? {startSeconds:range[0],endSeconds:range[1],
    raw:summarize(measure(raw.filter(s=>s.takeTimeMs>=range[0]*1000 && s.takeTimeMs<=range[1]*1000),range[1]*1000)),
    cleaned:summarize(measure(cleaned.samples.filter(s=>s.takeTimeMs>=range[0]*1000 && s.takeTimeMs<=range[1]*1000),range[1]*1000))} : undefined;
  const selected:number[]=[];
  for(const events of [before.worst,after.worst]) {
    let added=0;
    for(const event of events)if(selected.every(i=>Math.abs(raw[i].takeTimeMs-event.timeMs)>2000)) {selected.push(event.frame);if(++added>=4)break;}
  }
  // Include challenging low squats independently of the numerical ranking.
  for(const time of [75000,150000,200000,225000,250000]) {const i=raw.findIndex(s=>s.takeTimeMs>=time);if(i>=0 && selected.every(n=>Math.abs(raw[n].takeTimeMs-time)>2000))selected.push(i);}
  const firstDetection=raw.findIndex(s=>s.poses.length);
  if(firstDetection>=0)selected.push(firstDetection);
  const contactFrames=selected.flatMap(i=>[Math.max(0,i-1),i,Math.min(raw.length-1,i+1)]).map(i=>({timeMs:raw[i].takeTimeMs,raw:raw[i].poses[0] ?? null,cleaned:cleaned.samples[i].poses[0] ?? null}));
  // FFmpeg supplies exact decoded source frames even when browser seeking is
  // unreliable for AV1. Inference above still uses the original browser pipeline.
  const times=[...new Set(contactFrames.map(f=>f.timeMs))].sort((a,b)=>a-b);
  const filter=times.map(t=>`between(t\\,${(t/1000-.0005).toFixed(6)}\\,${(t/1000+.0005).toFixed(6)})`).join('+');
  console.log(`Extracting ${times.length} source frames for visual review`);
  await promisify(execFile)('ffmpeg',['-hide_banner','-loglevel','error','-i',source,'-vf',`select=${filter},scale=480:270`,'-fps_mode','vfr','-y',path.join(output,'source-%03d.png')]);
  const sources=new Map<number,string>();
  for(const [i,time] of times.entries())sources.set(time,`data:image/png;base64,${(await readFile(path.join(output,`source-${String(i+1).padStart(3,'0')}.png`))).toString('base64')}`);
  const framesWithSource=contactFrames.map(frame=>({...frame,source:sources.get(frame.timeMs)!}));
  const images=await page.evaluate(async({frames,connections})=>{
    const canvas=document.createElement('canvas');canvas.width=960;canvas.height=310;
    const g=canvas.getContext('2d')!,images:{timeMs:number;jpeg:string}[]=[];
    for(const frame of frames){
      const source=await createImageBitmap(await(await fetch(frame.source)).blob());
      g.fillStyle='#101820';g.fillRect(0,0,960,310);
      for(const [column,pose] of [frame.raw,frame.cleaned].entries()){
        g.drawImage(source,column*480,32,480,270);g.fillStyle='white';g.font='16px sans-serif';g.fillText(`${(frame.timeMs/1000).toFixed(3)}s · ${column?'cleaned':'raw'}`,column*480+8,23);
        if(!pose)continue;
        for(const [a,b] of connections){const p=pose.landmarks[a],q=pose.landmarks[b];g.strokeStyle=(p.confidence ?? 0)<.5 || (q.confidence ?? 0)<.5?'#ff5959':'#32ff9b';g.lineWidth=2;g.beginPath();g.moveTo(column*480+p.x*480,32+p.y*270);g.lineTo(column*480+q.x*480,32+q.y*270);g.stroke();}
      }
      images.push({timeMs:frame.timeMs,jpeg:canvas.toDataURL('image/jpeg',.88)});
      source.close();
    }
    return images;
  },{frames:framesWithSource,connections:CONNECTIONS});
  for(const [i,item] of images.entries())await writeFile(path.join(output,`review-${String(i).padStart(2,'0')}.jpg`),Buffer.from(item.jpeg.split(',')[1],'base64'));
  const {residuals:ignoredBefore,...rawStats}=before,{residuals:ignoredAfter,...cleanedStats}=after;
  void ignoredBefore;void ignoredAfter;
  const report={source,size,durationMs:result.durationMs,model:'lite',captureMode:'p1',targetRateHz:30,elapsedSeconds,frames:raw.length,
    calibrationAttempts:result.calibrationAttempts,status:result.status,counts:cleaned.counts,torsoScale:scale,raw:rawStats,cleaned:cleanedStats,windowStats,
    reviewTimesMs:contactFrames.map(f=>f.timeMs),
    checks:{timestampsPreserved:true,noDetectedPosesRemoved:true,measuredConfidencePreserved:true,reconstructedJointsRequireReview:true},
    worstRaw:before.worst.map(r=>({...r,jointName:JOINT_NAMES[r.joint]})),worstCleaned:after.worst.map(r=>({...r,jointName:JOINT_NAMES[r.joint]})),
    note:'Temporal stability metrics are proxies, not labeled pose accuracy. Red overlay marks unreliable or reconstructed joints. Review source alignment visually.'};
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
  const summaryRaw=windowStats?.raw ?? rawStats,summaryCleaned=windowStats?.cleaned ?? cleanedStats;
  const scope=windowStats ? `Reviewed window: ${windowStats.startSeconds}–${windowStats.endSeconds} seconds. The entire source was processed.` : 'Entire source.';
  const table=`<table><tr><th>Measure</th><th>Raw</th><th>Cleaned</th></tr><tr><td>99th-percentile temporal deviation (torso lengths)</td><td>${summaryRaw.residualP99.toFixed(3)}</td><td>${summaryCleaned.residualP99.toFixed(3)}</td></tr><tr><td>Large joint-frame deviations (&gt;0.6 torso lengths)</td><td>${summaryRaw.residualAbovePointSix}</td><td>${summaryCleaned.residualAbovePointSix}</td></tr><tr><td>Missing poses</td><td>${summaryRaw.missingFrames}</td><td>${summaryCleaned.missingFrames}</td></tr></table>`;
  await writeFile(path.join(output,'report.html'),`<!doctype html><meta charset="utf-8"><title>Pose validation</title><style>body{background:#101820;color:#eef;font:16px sans-serif;max-width:1100px;margin:24px auto}img{width:100%}pre{white-space:pre-wrap}td,th{padding:12px;text-align:left;border-bottom:1px solid #456}summary{cursor:pointer;margin:20px 0}h2{margin-top:40px}</style><h1>Lite / 30 fps / solo validation</h1><p>${scope}</p>${table}<p>${report.note} Deviation is the distance from a joint to time-weighted interpolation between its neighboring frames, divided by median torso length.</p><details><summary>Full metrics and provenance</summary><pre>${JSON.stringify({...report,worstRaw:undefined,worstCleaned:undefined,raw:{...rawStats,worst:undefined},cleaned:{...cleanedStats,worst:undefined}},null,2)}</pre></details><h2>Raw and cleaned overlays</h2>${images.map(i=>`<img src="${i.jpeg}" alt="Raw and cleaned poses at ${(i.timeMs/1000).toFixed(3)} seconds">`).join('\n')}`);
  console.log(JSON.stringify({frames:raw.length,status:result.status,counts:cleaned.counts,checks:report.checks,scope,
    raw:{...summaryRaw,gaps:undefined,worst:undefined},cleaned:{...summaryCleaned,gaps:undefined,worst:undefined}},null,2));
  console.log(`Validation artifacts: ${output}`);
} finally {
  await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await vite.close();
}

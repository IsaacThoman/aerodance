import * as ort from '/web/node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs';
import { FilesetResolver, PoseLandmarker } from '/repo/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs';
const map = [0,2,5,7,8,11,12,13,14,15,16,23,24,25,26,27,28];
const get = async u => {const r=await fetch(u);if(!r.ok)throw Error(`${u}: ${r.status}`);return r;};
function decodeRTMO(outputs,ratio){
 const [det,pose]=Object.values(outputs), people=[];
 const count=det.dims[1], joints=pose.dims[2];
 const candidates=Array.from({length:count},(_,i)=>i).filter(i=>det.data[i*5+4]>.3).sort((a,b)=>det.data[b*5+4]-det.data[a*5+4]);
 const kept=[];
 function iou(a,b){const d=det.data,A=a*5,B=b*5,inter=Math.max(0,Math.min(d[A+2],d[B+2])-Math.max(d[A],d[B]))*Math.max(0,Math.min(d[A+3],d[B+3])-Math.max(d[A+1],d[B+1]));return inter/((d[A+2]-d[A])*(d[A+3]-d[A+1])+(d[B+2]-d[B])*(d[B+3]-d[B+1])-inter);}
 for(const i of candidates){if(kept.some(k=>iou(i,k)>.45))continue;kept.push(i);const kp=Array(33).fill(null);for(let j=0;j<17;j++){const o=(i*joints+j)*3;kp[map[j]]=[pose.data[o]/ratio/640,pose.data[o+1]/ratio/480,0,Math.max(0,Math.min(1,pose.data[o+2]))];}people.push({kp,score:det.data[i*5+4]});}
 return people;
}
self.onmessage=async({data:c})=>{try{
 const gl=new OffscreenCanvas(1,1).getContext('webgl2'); const ext=gl?.getExtension('WEBGL_debug_renderer_info'); const renderer=ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):'unknown';
 if(/SwiftShader|llvmpipe/i.test(renderer))throw Error(`Software renderer: ${renderer}`);
 const img=await createImageBitmap(await (await get(`/data/browser-fixtures/${c.people}.png`)).blob());
 const times=[], report={...c,requested_people:c.people,renderer,download_bytes:0}; let infer,close=()=>{};
 if(c.model.startsWith('mp-')){
   const file=`pose_landmarker_${c.model.slice(3)}.task`, start=performance.now();
   const buffer=await (await get(`/data/models/${file}`)).arrayBuffer();report.download_bytes=buffer.byteLength;report.fetch_ms=performance.now()-start;
   const init=performance.now();const files=await FilesetResolver.forVisionTasks('/repo/node_modules/@mediapipe/tasks-vision/wasm',true);
   const model=await PoseLandmarker.createFromOptions(files,{baseOptions:{modelAssetBuffer:new Uint8Array(buffer),delegate:'GPU'},canvas:new OffscreenCanvas(1,1),runningMode:'VIDEO',numPoses:c.people,minPoseDetectionConfidence:.5,minPosePresenceConfidence:.5,minTrackingConfidence:.5});
   report.init_ms=performance.now()-init;let t=0;
   infer=async()=>model.detectForVideo(img,t+=34).landmarks.map(p=>({kp:p.map(p=>[p.x,p.y,p.z,Math.min(p.visibility,p.presence)])}));close=()=>model.close();
 }else{
   ort.env.wasm.wasmPaths='/web/node_modules/onnxruntime-web/dist/';ort.env.wasm.numThreads=1;
   const start=performance.now(), buffer=await(await get(`/data/models/${c.model}.onnx`)).arrayBuffer();report.download_bytes=buffer.byteLength;report.fetch_ms=performance.now()-start;
   const init=performance.now();const session=await ort.InferenceSession.create(buffer,{executionProviders:[c.backend],graphOptimizationLevel:'all'});report.init_ms=performance.now()-init;
   const meta=await(await get(`/data/browser-fixtures/${c.model}-${c.people}.json`)).json();const size=meta.input_size;
   // Exact Python tensor isolates backend differences from resize/interpolation differences.
   const exact=new Float32Array(await(await get(`/data/browser-fixtures/${c.model}-${c.people}.bin`)).arrayBuffer());
   const output=await session.run({[session.inputNames[0]]:new ort.Tensor('float32',exact,[1,3,size,size])});report.parity=[];
   for(let i=0;i<meta.outputs.length;i++){const expected=new Float32Array(await(await get(`/data/browser-fixtures/${meta.outputs[i].file}`)).arrayBuffer()),actual=output[session.outputNames[i]].data;let max=0,sum=0;for(let j=0;j<expected.length;j++){const d=Math.abs(actual[j]-expected[j]);max=Math.max(max,d);sum+=d;}report.parity.push({shape:output[session.outputNames[i]].dims,max_abs:max,mean_abs:sum/expected.length,length_match:expected.length===actual.length});}
   report.exact_tensor_people=decodeRTMO(output,meta.ratio);
   const canvas=new OffscreenCanvas(size,size),ctx=canvas.getContext('2d',{willReadFrequently:true});
   infer=async()=>{ctx.fillStyle='rgb(114,114,114)';ctx.fillRect(0,0,size,size);ctx.drawImage(img,0,0,Math.floor(640*meta.ratio),Math.floor(480*meta.ratio));const pixels=ctx.getImageData(0,0,size,size).data,x=new Float32Array(3*size*size);for(let i=0;i<size*size;i++){x[i]=pixels[4*i+2];x[size*size+i]=pixels[4*i+1];x[2*size*size+i]=pixels[4*i];}const out=await session.run({[session.inputNames[0]]:new ort.Tensor('float32',x,[1,3,size,size])});return decodeRTMO(out,meta.ratio);};close=()=>session.release();
 }
 let people;for(let i=0;i<3+c.iterations;i++){const start=performance.now();people=await infer();if(i>=3)times.push(performance.now()-start);}
 report.times_ms=times;report.detections=people;report.memory=performance.memory?{usedJSHeapSize:performance.memory.usedJSHeapSize}:null;
 report.memory_note='Worker heap API usually unavailable; GPU allocations not measurable by this API. Process RSS reported by launcher.';
 await close();img.close();self.postMessage(report);
 }catch(e){self.postMessage({error:String(e.stack||e)});}};

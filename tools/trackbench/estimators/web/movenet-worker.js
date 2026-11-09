/* global importScripts, tf */
importScripts('/web/node_modules/@tensorflow/tfjs/dist/tf.min.js');
self.onmessage=async({data:c})=>{try{
 await tf.setBackend('webgl');await tf.ready();
 const canvas=new OffscreenCanvas(640,480),ctx=canvas.getContext('2d',{willReadFrequently:true});
 const image=await createImageBitmap(await(await fetch(`/data/browser-fixtures/${c.people}.png`)).blob());ctx.drawImage(image,0,0);
 const rgba=ctx.getImageData(0,0,640,480).data;
 const rgb=new Int32Array(640*480*3);for(let i=0;i<640*480;i++)for(let j=0;j<3;j++)rgb[i*3+j]=rgba[i*4+j];
 const graph=await(await fetch('/data/models/movenet-multipose-tfjs/model.json')).json();let bytes=JSON.stringify(graph).length;
 for(const g of graph.weightsManifest)for(const p of g.paths)bytes+=(await(await fetch('/data/models/movenet-multipose-tfjs/'+p)).arrayBuffer()).byteLength;
 const init=performance.now(),model=await tf.loadGraphModel('/data/models/movenet-multipose-tfjs/model.json');const init_ms=performance.now()-init;
 const map=[0,2,5,7,8,11,12,13,14,15,16,23,24,25,26,27,28];
 const infer=async()=>{const x=tf.tidy(()=>tf.pad(tf.image.resizeBilinear(tf.tensor3d(rgb,[480,640,3]),[192,256],false,true),[[32,32],[0,0],[0,0]]).toInt().expandDims());const out=await model.executeAsync(x);const tensor=Array.isArray(out)?out[0]:out;const raw=Array.from(await tensor.data());x.dispose();tf.dispose(out);return raw;};
 const times=[];let raw;
 for(let i=0;i<c.iterations+3;i++){const t=performance.now();raw=await infer();if(i>=3)times.push(performance.now()-t);}
 const detections=[];for(let i=0;i<6;i++){const p=raw.slice(i*56,(i+1)*56);if(p[55]<.2)continue;const kp=Array(33).fill(null);for(let j=0;j<17;j++)kp[map[j]]=[p[j*3+1],(p[j*3]*256-32)/192,0,p[j*3+2]];detections.push({kp,score:p[55]});}
 const expected=await(await fetch(`/data/browser-fixtures/movenet-${c.people}.json`)).json();const delta=raw.map((v,i)=>Math.abs(v-expected[i]));
 const gl=new OffscreenCanvas(1,1).getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info'),renderer=gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);if(/SwiftShader/i.test(renderer))throw Error(renderer);
 self.postMessage({...c,requested_people:c.people,renderer,init_ms,download_bytes:bytes,times_ms:times,detections,parity:{max_abs:Math.max(...delta),mean_abs:delta.reduce((a,b)=>a+b,0)/delta.length},memory:tf.memory(),memory_note:'TF.js tensor bytes, not total GPU/process memory'});model.dispose();image.close();
 }catch(e){self.postMessage({error:String(e.stack||e)});}};

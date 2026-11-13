import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {chromiumPath} from '../../../../scripts/chromium.ts';
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../../../..'),data=process.env.TRACKBENCH_DATA||'/Volumes/development/aerodance-trackbench';
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.json':'application/json','.png':'image/png'};
const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://localhost'),roots={'web':here,'data':data,'repo':repo};let [prefix,...parts]=decodeURIComponent(u.pathname).slice(1).split('/');if(!prefix){prefix='web';parts=['index.html'];}const root=roots[prefix];if(!root)throw Error('root');const file=path.resolve(root,...parts);if(!file.startsWith(root+'/'))throw Error('path');const bytes=await fs.readFile(file);res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'});res.end(bytes);}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const executable=process.env.CHROMIUM||chromiumPath(false);
const browserServer=await chromium.launchServer({executablePath:executable,headless:true,args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--enable-unsafe-webgpu']});
const browser=await chromium.connect(browserServer.wsEndpoint());
const report={machine:os.release(),browser:browser.version(),created:new Date().toISOString(),results:[],notes:'Repeated still 640x480 images, 3 warmups; not live video or sustained thermal test; Python parity uses identical input tensors.'};
try{
const selected=process.argv.slice(2); const models=selected.length?selected:['rtmo-t','rtmo-s','movenet-multipose','mp-lite','mp-full','mp-heavy'];
for(const model of models)for(const people of [1,4])for(const backend of (model.startsWith('mp-')||model.startsWith('movenet'))?['webgl']:['webgpu','wasm']){
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`);
 const config={model,people,backend,iterations:10};console.log('Start',config);
 try{const result=await page.evaluate(c=>Promise.race([window.probe(c),new Promise((_,reject)=>setTimeout(()=>reject(Error('120s timeout')),120000))]),config);result.mean_ms=result.times_ms.reduce((a,b)=>a+b,0)/result.times_ms.length;const procs=execFileSync('ps',['-axo','pid=,ppid=,rss='],{encoding:'utf8'}).trim().split('\n').map(l=>l.trim().split(/\s+/).map(Number));const pids=new Set([browserServer.process().pid]);for(let i=0;i<10;i++)for(const [pid,ppid] of procs)if(pids.has(ppid))pids.add(pid);result.browser_process_rss_kb=procs.filter(([pid])=>pids.has(pid)).reduce((sum,p)=>sum+p[2],0);report.results.push(result);console.log(model,people,backend,result.mean_ms,'ms');}catch(e){report.results.push({...config,error:String(e)});console.log(String(e));}finally{await page.close();}
 await fs.mkdir(path.join(data,'browser-results'),{recursive:true});await fs.writeFile(path.join(data,'browser-results','latest.json'),JSON.stringify(report,null,2));
}
}finally{await browser.close();await browserServer.close();server.close();}

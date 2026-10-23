import { qualityFor, isObject, MAX_DANCERS } from '../../packages/pose/choreography.ts';
import type { FrameSize, Landmark, Pose, PoseQuality } from '../../packages/pose/choreography.ts';

export const CLEANUP_SETTINGS = Object.freeze({ version: 1, confidence: .5, maxGapMs: 200, xyWindowMs: 120, zWindowMs: 180 });
export interface CleanupSample { takeTimeMs: number; poses: Pose[]; quality?: PoseQuality[]; }
export interface CleanupCounts { smoothedJoints: number; repairedJoints: number; repairedGaps: number; unresolvedJoints: number; unresolvedGaps: number; }
export interface CleanupOptions { startMs?: number; endMs?: number; playerId?: number | null; smoothOnly?: boolean; windowMs?: number; }
const median = (values: number[]) => { values.sort((a,b) => a-b); return values.length ? values[Math.floor(values.length / 2)] : 0; };
const reliable = (p: Landmark | undefined) => p != null && p.confidence !== null && p.confidence >= CLEANUP_SETTINGS.confidence;
const torso = (p: Pose) => ({ x: (p.landmarks[23].x+p.landmarks[24].x)/2, y: (p.landmarks[23].y+p.landmarks[24].y)/2 });
const LIMBS = [[11,13],[13,15],[12,14],[14,16],[23,25],[25,27],[24,26],[26,28]];

/** Offline, centered cleanup. Never mutates inputs, timing, or another player's slot. */
export function cleanupPoses<T extends CleanupSample>(input: readonly T[], size: FrameSize, options: CleanupOptions = {}): { samples: T[]; counts: CleanupCounts } {
  const samples = structuredClone(input) as T[];
  const counts: CleanupCounts = { smoothedJoints: 0, repairedJoints: 0, repairedGaps: 0, unresolvedJoints: 0, unresolvedGaps: 0 };
  const aspect = size.width / size.height;
  const distance = (a: {x:number;y:number}, b: {x:number;y:number}) => Math.hypot((a.x-b.x)*aspect,a.y-b.y);
  const selected = (i: number) => samples[i].takeTimeMs >= (options.startMs ?? -Infinity) && samples[i].takeTimeMs < (options.endMs ?? Infinity);
  samples.forEach(s => { s.quality ??= qualityFor(s.poses); });
  for (let id = 0; id < MAX_DANCERS; id++) {
    if (options.playerId != null && options.playerId !== id) continue;
    const original = input.map(s => s.poses.find(p => p.playerId === id));
    const hasOriginal = original.some(Boolean);
    const lengths = original.flatMap(p => p && [11,12,23,24].every(j => reliable(p.landmarks[j]))
      ? [distance(torso(p), {x:(p.landmarks[11].x+p.landmarks[12].x)/2,y:(p.landmarks[11].y+p.landmarks[12].y)/2})] : []).filter(v => v > .001);
    const scale = median(lengths);
    if (!scale) {
      // Without a reliable body scale, preserve coordinates and report rather
      // than inventing a motion threshold or trusting unknown measurements.
      let inGap = false;
      samples.forEach((s,i) => {
        const pose = s.poses.find(p => p.playerId === id);
        if (pose) {
          inGap = false;
          if (!selected(i)) return;
          const quality = s.quality!.find(q => q.playerId === id)!;
          pose.landmarks.forEach((joint,j) => {
            if (!reliable(joint)) { quality.scoreEligible[j]=false; quality.reviewed=false; counts.unresolvedJoints++; }
          });
        } else if (selected(i) && hasOriginal) {
          if (!inGap) counts.unresolvedGaps++;
          inGap = true;
        }
      });
      continue;
    }
    const segment: number[] = [];
    let last = -1, group = 0;
    original.forEach((p,i) => {
      if (p) {
        if (last >= 0 && (samples[i].takeTimeMs-samples[last].takeTimeMs > 200 || distance(torso(p),torso(original[last]!)) > scale)) group++;
        last=i;
      }
      segment[i]=group;
    });
    const valid = original.map(p => Array.from({length:33},(_,j) => reliable(p?.landmarks[j])));
    // A local baseline avoids assuming all dancers have the same projected limbs.
    for (let i=1;i+1<samples.length;i++) {
      const a=original[i-1],p=original[i],b=original[i+1];
      if (!a || !p || !b || segment[i-1]!==segment[i+1] || samples[i+1].takeTimeMs-samples[i-1].takeTimeMs>200) continue;
      const alpha=(samples[i].takeTimeMs-samples[i-1].takeTimeMs)/(samples[i+1].takeTimeMs-samples[i-1].takeTimeMs);
      for (let j=0;j<33;j++) {
        if (!valid[i-1][j] || !valid[i][j] || !valid[i+1][j]) continue;
        const x=a.landmarks[j],y=p.landmarks[j],z=b.landmarks[j];
        const residual=distance(y,{x:x.x+(z.x-x.x)*alpha,y:x.y+(z.y-x.y)*alpha})/scale;
        const reversal=((y.x-x.x)*(z.x-y.x)*aspect*aspect+(y.y-x.y)*(z.y-y.y))<0;
        let badLimb=false;
        if (residual>.35) for (const limb of LIMBS.filter(pair => pair.includes(j))) {
          const [u,v]=limb;
          const baseline: number[]=[];
          for (let n=i-1;n>=0 && samples[i].takeTimeMs-samples[n].takeTimeMs<=500;n--)
            if (segment[n]===segment[i] && original[n] && valid[n][u] && valid[n][v]) baseline.push(distance(original[n]!.landmarks[u],original[n]!.landmarks[v]));
          for (let n=i+1;n<samples.length && samples[n].takeTimeMs-samples[i].takeTimeMs<=500;n++)
            if (segment[n]===segment[i] && original[n] && valid[n][u] && valid[n][v]) baseline.push(distance(original[n]!.landmarks[u],original[n]!.landmarks[v]));
          const typical=median(baseline);
          if (typical>.001 && distance(p.landmarks[u],p.landmarks[v])>1.75*typical) badLimb=true;
        }
        if ((residual>.6 && reversal && distance(x,y)>.75*scale && distance(y,z)>.75*scale) || badLimb) valid[i][j]=false;
      }
    }
    const outputPose = (i:number) => samples[i].poses.find(p => p.playerId===id);
    const outputQuality = (i:number) => samples[i].quality!.find(q => q.playerId===id)!;
    const repaired = new Set<string>();
    const repairedFrames = new Set<number>();
    if (!options.smoothOnly) for (let j=0;j<33;j++) {
      let left=-1;
      for (let right=0;right<samples.length;right++) {
        if (!valid[right][j]) continue;
        if (left>=0 && right>left+1 && samples[right].takeTimeMs-samples[left].takeTimeMs<=200 && segment[left]===segment[right]) {
          const a=original[left]!,b=original[right]!;
          if (distance(torso(a),torso(b))<=.75*scale && distance(a.landmarks[j],b.landmarks[j])<=1.5*scale) {
            // Whole-pose repair requires every joint to have supported endpoints.
            const wholeOK=Array.from({length:33},(_,k) => valid[left][k] && valid[right][k] && distance(a.landmarks[k],b.landmarks[k])<=1.5*scale).every(Boolean);
            for (let n=left+1;n<right;n++) {
              if (!selected(n)) continue;
              let pose=outputPose(n);
              if (!pose) {
                if (!wholeOK) continue;
                pose={playerId:id,landmarks:a.landmarks.map(p => ({...p,confidence:null}))};
                samples[n].poses.push(pose);
                samples[n].quality!.push({playerId:id,landmarkOrigins:Array(33).fill('gap-repaired'),scoreEligible:Array(33).fill(false),reviewed:false});
                repairedFrames.add(n);
              }
              const alpha=(samples[n].takeTimeMs-samples[left].takeTimeMs)/(samples[right].takeTimeMs-samples[left].takeTimeMs);
              const x=a.landmarks[j],y=b.landmarks[j];
              pose.landmarks[j]={x:x.x+(y.x-x.x)*alpha,y:x.y+(y.y-x.y)*alpha,z:x.z+(y.z-x.z)*alpha,confidence:null};
              const quality=outputQuality(n);
              quality.landmarkOrigins[j]='gap-repaired'; quality.scoreEligible[j]=false; quality.reviewed=false;
              repaired.add(`${n}:${j}`);
            }
          }
        }
        left=right;
      }
    }
    // Presence gaps divide smoothing, even when short ones have been repaired.
    const smoothingSegments: number[]=[];
    let smoothingGroup=0;
    samples.forEach((s,i) => { if (i && (segment[i]!==segment[i-1] || !original[i] || !original[i-1])) smoothingGroup++; smoothingSegments[i]=smoothingGroup; });
    for (let i=0;i<samples.length;i++) {
      if (!selected(i)) continue;
      const pose=outputPose(i);
      if (!pose) continue;
      const quality=outputQuality(i);
      for (let j=0;j<33;j++) {
        if (repaired.has(`${i}:${j}`)) continue;
        if (!valid[i][j]) { quality.scoreEligible[j]=false; quality.reviewed=false; counts.unresolvedJoints++; continue; }
        let changed=false;
        for (const axis of ['x','y','z'] as const) {
          const half=(options.windowMs ?? (axis==='z'?180:120))/2;
          const neighbors: number[]=[];
          for (let n=i;n>=0 && samples[i].takeTimeMs-samples[n].takeTimeMs<=half;n--) { if (smoothingSegments[n]!==smoothingSegments[i] || !valid[n][j]) break; neighbors.push(n); }
          for (let n=i+1;n<samples.length && samples[n].takeTimeMs-samples[i].takeTimeMs<=half;n++) { if (smoothingSegments[n]!==smoothingSegments[i] || !valid[n][j]) break; neighbors.push(n); }
          if (neighbors.length<3) continue;
          let w=0,wt=0,wtt=0,wy=0,wty=0;
          for (const n of neighbors) {
            const t=(samples[n].takeTimeMs-samples[i].takeTimeMs)/half;
            const weight=original[n]!.landmarks[j].confidence! * Math.exp(-2*t*t),value=original[n]!.landmarks[j][axis];
            w+=weight; wt+=weight*t; wtt+=weight*t*t; wy+=weight*value; wty+=weight*t*value;
          }
          const denominator=w*wtt-wt*wt;
          if (denominator<=1e-12) continue;
          const value=(wy*wtt-wty*wt)/denominator;
          if (Math.abs(value-pose.landmarks[j][axis])>1/16384) { pose.landmarks[j][axis]=value; changed=true; }
        }
        if (changed) { quality.landmarkOrigins[j]='edited'; quality.reviewed=false; counts.smoothedJoints++; }
      }
    }
    counts.repairedJoints+=repaired.size;
    for (let i=0;i<samples.length;i++) if (!original[i]) {
      let end=i; while (end+1<samples.length && !original[end+1]) end++;
      const run=Array.from({length:end-i+1},(_,k)=>i+k);
      if (run.some(selected)) {
        if (run.every(n=>repairedFrames.has(n))) counts.repairedGaps++;
        else counts.unresolvedGaps++;
      }
      i=end;
    }
  }
  samples.forEach(s => { s.poses.sort((a,b)=>a.playerId-b.playerId); s.quality!.sort((a,b)=>a.playerId-b.playerId); });
  return {samples,counts};
}
export function cleanupMessage(counts: CleanupCounts): string {
  return `${counts.smoothedJoints} joints smoothed, ${counts.repairedJoints} joints repaired, ${counts.repairedGaps} gaps repaired; ${counts.unresolvedJoints} joints and ${counts.unresolvedGaps} gaps need review.`;
}
export function cleanupSummary(provenance: unknown): string {
  if (!isObject(provenance) || !isObject(provenance.cleanupCounts)) return '';
  const counts = provenance.cleanupCounts;
  const keys = ['smoothedJoints', 'repairedJoints', 'repairedGaps', 'unresolvedJoints', 'unresolvedGaps'] as const;
  if (!keys.every(k => typeof counts[k] === 'number' && Number.isInteger(counts[k]) && counts[k] >= 0)) return '';
  return cleanupMessage(counts as unknown as CleanupCounts);
}

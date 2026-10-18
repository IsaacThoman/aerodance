import type { Pose } from '../pose/choreography.ts';

// Display-only smoothing; the caller's landmarks and confidence are untouched.
export class LivePoseFilter {
  timeConstant: number;
  current: Pose | null = null;
  /** True while the smoothed pose is still catching up with the input. */
  settling = false;
  constructor(timeConstant=.12) { this.timeConstant=timeConstant; }
  reset() { this.current=null; this.settling=false; }
  update(pose: Pose | null, delta: number) {
    if(!pose) { this.reset(); return pose; }
    if(!this.current || this.current.playerId!==pose.playerId) {
      this.current={...pose,landmarks:pose.landmarks.map(p=>({...p}))};
      return this.current;
    }
    const alpha=1-Math.exp(-Math.max(0,delta)/this.timeConstant);
    this.settling=false;
    const current=this.current;
    pose.landmarks.forEach((p,i)=>{
      const joint=current.landmarks[i];
      for(const axis of ['x','y','z'] as const) {
        joint[axis]+=(p[axis]-joint[axis])*alpha;
        if(Math.abs(p[axis]-joint[axis])>.0002) this.settling=true;
      }
      joint.confidence=p.confidence;
    });
    return this.current;
  }
}

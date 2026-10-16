import { Matrix4, Vector3 } from 'three';
import type { Bone, Object3D } from 'three';
import type { Landmark, Pose, TrackCalibration } from '../pose/choreography.ts';
export { calibratePoses } from './calibration.ts';

export interface PoseApplierOptions {
  /** Live input: damp the camera-distance estimate over time instead of following every frame. */
  smoothDistance?: boolean;
}
/** Poses the rig; a missing pose hides the model. delta is the frame time in seconds. */
export interface PoseApplier {
  (pose: Pose | null | undefined, delta?: number): void;
  /** True while distance smoothing is still converging (keep rendering). */
  settling: boolean;
}
const clamp = (x: number,a: number,b: number) => Math.min(b,Math.max(a,x));
const mid = (p: readonly Landmark[],a: number,b: number) => ({x:(p[a].x+p[b].x)/2,y:(p[a].y+p[b].y)/2,z:(p[a].z+p[b].z)/2});
const isBone = (o: Object3D): o is Bone => 'isBone' in o && o.isBone === true;
/** One pose applier for recorded, edited and live poses. */
export function createPoseApplier(model: Object3D, calibration: TrackCalibration, {smoothDistance=false}: PoseApplierOptions = {}): PoseApplier {
  const bones = new Map<string, Bone>();
  model.traverse(o=>{if(isBone(o)) bones.set(o.name,o);});
  const bone = (name: string) => { const b=bones.get(name); if(!b) throw Error(`Missing rig bone: ${name}`); return b; };
  const [Root,Body,Head,ArmL,ArmR,FootL,FootR]=['Root','Body','Head','ArmL','ArmR','FootL','FootR'].map(bone);
  const {torsoLength,baseHip,floorY,inputWidth,inputHeight}=calibration;
  const aspect=inputWidth/inputHeight, baseScale=1.05/torsoLength;
  const adaptiveDistance=calibration.cameraScaleMode==='body-relative';
  const target=new Vector3(),offset=new Vector3(),parentInverse=new Matrix4();
  let stableDistance: number | null=null;
  function center(bone: Bone,x: number,y: number,z: number,ox: number,oy: number,oz: number) {
    const parent=bone.parent;
    if(!parent) throw Error(`Rig bone has no parent: ${bone.name}`);
    // The rig and its ancestors are current for this pose. Avoid walking and
    // recomposing that same chain twice for every hand and foot.
    target.set(x,y,z).applyMatrix4(model.matrixWorld).applyMatrix4(parentInverse.copy(parent.matrixWorld).invert());
    offset.set(ox,oy,oz).applyQuaternion(bone.quaternion); bone.position.copy(target.sub(offset)); bone.updateMatrixWorld(true);
  }
  const apply: PoseApplier=Object.assign((pose: Pose | null | undefined,delta=1/60) => {
    apply.settling=false;
    if(!pose) {model.visible=false;stableDistance=null;return;}
    model.visible=true;
    const p=pose.landmarks,h=mid(p,23,24),s=mid(p,11,12);
    // A wider lens or stepping back shrinks every image-space limb. Match the
    // measured torso to its neutral image size. Estimated Z is too noisy to
    // use for whole-character scale; it still controls bounded limb depth.
    // Rescale the neutral hip/floor around the image center too: changing only
    // limb scale would still pull the feet upward and shift the root.
    let distanceRatio=1;
    if(adaptiveDistance && [11,12,23,24].every(i=>{
      const {visibility,presence}=p[i];
      return visibility!==null && presence!==null && Math.min(visibility,presence)>=.5;
    })) {
      const length=Math.hypot((h.x-s.x)*aspect,h.y-s.y);
      if(length>.001) distanceRatio=length/torsoLength;
    }
    if(adaptiveDistance && smoothDistance) {
      stableDistance ??= distanceRatio;
      stableDistance+=(distanceRatio-stableDistance)*(1-Math.exp(-Math.max(0,delta)/.25));
      apply.settling=Math.abs(distanceRatio-stableDistance)>.001;
      distanceRatio=stableDistance;
    }
    const scale=baseScale/distanceRatio,depthAspect=adaptiveDistance?aspect:1;
    const hipX=.5+(baseHip.x-.5)*distanceRatio,hipY=.5+(baseHip.y-.5)*distanceRatio;
    const currentFloorY=.5+(floorY-.5)*distanceRatio;
    const rootX=(h.x-hipX)*aspect*scale,rootY=clamp((hipY-h.y)*scale*.65,-.35,.65);
    Root.position.set(rootX,rootY,0);
    const roll=clamp(-Math.atan2((s.x-h.x)*aspect,h.y-s.y),-.65,.65);
    const yaw=clamp(Math.atan2((p[11].z-p[12].z)*depthAspect,Math.abs(p[11].x-p[12].x)*aspect),-.8,.8);
    Body.rotation.set(0,yaw*.45,roll);
    const ears=mid(p,7,8),headYaw=clamp((p[0].x-ears.x)*aspect*scale*2,-.65,.65);
    const headRoll=clamp(-Math.atan2(p[7].y-p[8].y,Math.abs(p[7].x-p[8].x)*aspect),-.45,.45);
    Head.rotation.set(0,headYaw-yaw*.45,headRoll-roll); model.updateWorldMatrix(true,true);
    for(const [arm,foot,wrist,ankle,sign] of [[ArmL,FootL,16,28,-1],[ArmR,FootR,15,27,1]] as const) {
      center(arm,rootX+(p[wrist].x-h.x)*aspect*scale,rootY+1.1+(h.y-p[wrist].y)*scale,clamp(-(p[wrist].z-h.z)*depthAspect*scale*.35,-.7,.9),sign*.26,-.86,0);
      const fx=rootX+(p[ankle].x-h.x)*aspect*scale;
      const fy=Math.max(.3,.3+(currentFloorY-p[ankle].y)*scale);
      const fz=clamp(-(p[ankle].z-h.z)*depthAspect*scale*.25,-.45,.45);
      center(foot,fx,fy,fz,0,0,.13);
    }
  },{settling:false});
  return apply;
}

import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
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
// Torso tip: a torso turned toward or away from the camera by θ shows cos θ of its length. Within
// TIP_FROM it is a step toward or away from the camera, or tracking noise, so the tip starts there
// and still reaches a full 90° when the torso is end-on.
const TIP_FROM=.55,TIP_BACK=-1.1;
// A confident torso leans any way (bent double, a cartwheel); otherwise, as for a dancer half out of
// shot, at most LEAN.
const LEAN=.65;
// The head as MediaPipe and Dance Studio see it: ears about HEAD torso lengths apart, and the nose
// NOSE_DROP and NOSE_OUT of that width below and in front of their midpoint when level.
const HEAD=.24,NOSE_DROP=.12,NOSE_OUT=.55,NOD=.6,HEAD_TILT=.6;
// Turned around: the shoulders cross over by FLIP of their width and the nose is FLIP of the head's
// width behind the ears. Both must agree, so a side view's jitter doesn't spin the dancer.
const FLIP=.25;
// The parts' extents about the body bone (body) and the head's centre and radius, for the floor.
const BODY_BOX=[[-.6,.6],[-.5,.85],[-.4,.4]] as const,HEAD_Y=1.6,HEAD_R=.62,FLOOR_GAP=.02;
const UP=new Vector3(0,1,0),corner=new Vector3(),torso=new Vector3(),bodyQ=new Quaternion(),headQ=new Quaternion(),euler=new Euler();
/** How far below the body bone the lowest point of the body or head sits, turned by q. */
function lowest(q: Quaternion) {
  let low=corner.set(0,HEAD_Y,0).applyQuaternion(q).y-HEAD_R;
  for(const x of BODY_BOX[0]) for(const y of BODY_BOX[1]) for(const z of BODY_BOX[2]) low=Math.min(low,corner.set(x,y,z).applyQuaternion(q).y);
  return low;
}
/** Maps a turn past `from` (radians, either way) onto `shown` there through to π at π. */
const beyond=(angle: number,from: number,shown: number) => Math.sign(angle)*(shown+(Math.abs(angle)-from)/(Math.PI-from)*(Math.PI-shown));
/** One pose applier for recorded, edited and live poses. */
export function createPoseApplier(model: Object3D, calibration: TrackCalibration, {smoothDistance=false}: PoseApplierOptions = {}): PoseApplier {
  const bones = new Map<string, Bone>();
  model.traverse(o=>{if(isBone(o)) bones.set(o.name,o);});
  const bone = (name: string) => { const b=bones.get(name); if(!b) throw Error(`Missing rig bone: ${name}`); return b; };
  const [Root,Body,Head,ArmL,ArmR,FootL,FootR]=['Root','Body','Head','ArmL','ArmR','FootL','FootR'].map(bone);
  const {torsoLength,baseHip,floorY,inputWidth,inputHeight}=calibration;
  const aspect=inputWidth/inputHeight, baseScale=1.05/torsoLength;
  const adaptiveDistance=calibration.cameraScaleMode==='body-relative';
  const target=new Vector3(),offset=new Vector3();
  const parentInverses=new Map([ArmL,ArmR,FootL,FootR].map(limb=>[limb.parent,new Matrix4()]));
  let stableDistance: number | null=null;
  function center(bone: Bone,x: number,y: number,z: number,ox: number,oy: number,oz: number) {
    const parent=bone.parent;
    if(!parent) throw Error(`Rig bone has no parent: ${bone.name}`);
    // The rig and its ancestors are current for this pose. Avoid walking and
    // recomposing that same chain twice for every hand and foot.
    target.set(x,y,z).applyMatrix4(model.matrixWorld).applyMatrix4(parentInverses.get(parent)!);
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
      const c=p[i].confidence;
      return c!==null && c>=.5;
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
    const rootX=(h.x-hipX)*aspect*scale;
    let rootY=clamp((hipY-h.y)*scale*.65,-.35,.65);
    // Tracked depth is measured from the hips, so tracked dancers stay on their spot; an authored
    // dance can step its hips toward the camera (or away), e.g. one dancer passing in front of another.
    const rootZ=clamp(-(h.z-baseHip.z*distanceRatio)*depthAspect*scale,-2,2);
    const confident=[11,12,23,24].every(i=>{
      const c=p[i].confidence;
      return c===null || c>=.5;
    });
    const lateral=(s.x-h.x)*aspect,up=h.y-s.y,shown=Math.hypot(lateral,up);
    // Lean: the torso's direction on screen.
    const roll=confident ? -Math.atan2(lateral,up) : clamp(-Math.atan2(lateral,up),-LEAN,LEAN);
    // Body-relative scale measures the camera distance from the torso's length, so a live
    // dancer's torso is always its own length and never reads as tipped.
    let tip=0;
    if(!adaptiveDistance) {
      const angle=Math.acos(clamp(shown/torsoLength,0,1));
      tip=clamp((angle-TIP_FROM)/(Math.PI/2-TIP_FROM),0,1)*Math.PI/2;
      // Toward the camera unless the shoulders are clearly the farther: a backbend.
      if((s.z-h.z)*aspect>.3*torsoLength) tip=Math.max(TIP_BACK,-tip);
    }
    const ears=mid(p,7,8),head=HEAD*torsoLength*distanceRatio;
    // Facing away from the camera: the shoulders and the face must both say so.
    const shoulderX=(p[11].x-p[12].x)*aspect,shoulderZ=(p[11].z-p[12].z)*aspect;
    const noseBehind=(p[0].z-ears.z)*aspect>FLIP*head;
    const away=noseBehind && shoulderX < -FLIP*Math.hypot(shoulderX,shoulderZ);
    const yaw=clamp(Math.atan2((p[11].z-p[12].z)*depthAspect,Math.abs(p[11].x-p[12].x)*aspect),-.8,.8);
    // The body turns about half as far as the shoulders facing the camera, and on round to face
    // away from it when turned around.
    const bodyYaw=away ? beyond(Math.atan2(shoulderZ,shoulderX),Math.PI/2+FLIP,.8*.45) : yaw*.45;
    // The torso's direction: leaning as on screen and tipped toward the camera. One swing from upright
    // gets there, so a torso end-on to the camera (its lean undefined) doesn't spin about itself.
    torso.set(-Math.sin(roll)*Math.cos(tip),Math.cos(roll)*Math.cos(tip),Math.sin(tip));
    Body.quaternion.setFromUnitVectors(UP,torso).multiply(bodyQ.setFromAxisAngle(UP,bodyYaw));
    // Never through the floor, however the body turns.
    rootY=Math.max(rootY,FLOOR_GAP-1.1-lowest(Body.quaternion));
    Root.position.set(rootX,rootY,rootZ);
    // The head points where the face does, within a tilt of the body below it. The ears cross over
    // when the dancer turns around, and turn over with the body when it's upside down.
    const ex=(p[7].x-p[8].x)*aspect,ey=p[7].y-p[8].y,flip=noseBehind ? -1 : 1;
    const tilt=-Math.atan2(flip*ey,flip*ex);
    // An end-on torso has no lean to follow.
    const lean=roll*clamp(Math.cos(tip)*3,0,1);
    const headRoll=lean+clamp(Math.atan2(Math.sin(tilt-lean),Math.cos(tilt-lean)),-HEAD_TILT,HEAD_TILT);
    // The nose's offset from the ears, along and square to the line between them.
    const dx=(p[0].x-ears.x)*aspect,dy=p[0].y-ears.y;
    const along=dx*Math.cos(headRoll)-dy*Math.sin(headRoll),drop=dx*Math.sin(headRoll)+dy*Math.cos(headRoll);
    const headYaw=noseBehind ? beyond(Math.atan2(along,-(p[0].z-ears.z)*aspect),Math.PI/2,.65) : clamp(along*scale*2,-.65,.65);
    // Nod: that drop against a level face's.
    const nod=noseBehind || Math.hypot(dx,dy)<.1*head ? 0 : clamp(Math.acos(clamp(drop/(head*Math.hypot(NOSE_DROP,NOSE_OUT)),-1,1))-Math.atan2(NOSE_OUT,NOSE_DROP),-NOD,NOD);
    euler.set(-nod,headYaw,headRoll,'ZXY');
    headQ.setFromEuler(euler);
    Head.quaternion.copy(bodyQ.copy(Body.quaternion).invert().multiply(headQ));
    // Only the bone hierarchy is needed to place limbs. Its ancestor update also
    // refreshes model.matrixWorld; the renderer updates the mesh siblings later.
    Root.updateWorldMatrix(true,true);
    for(const [parent,inverse] of parentInverses) if(parent) inverse.copy(parent.matrixWorld).invert();
    for(const [arm,foot,wrist,ankle,sign] of [[ArmL,FootL,16,28,-1],[ArmR,FootR,15,27,1]] as const) {
      center(arm,rootX+(p[wrist].x-h.x)*aspect*scale,rootY+1.1+(h.y-p[wrist].y)*scale,rootZ+clamp(-(p[wrist].z-h.z)*depthAspect*scale*.35,-.7,.9),sign*.26,-.86,0);
      const fx=rootX+(p[ankle].x-h.x)*aspect*scale;
      const fy=Math.max(.3,.3+(currentFloorY-p[ankle].y)*scale);
      const fz=clamp(-(p[ankle].z-h.z)*depthAspect*scale*.25,-.45,.45);
      center(foot,fx,fy,rootZ+fz,0,0,.13);
    }
  },{settling:false});
  return apply;
}

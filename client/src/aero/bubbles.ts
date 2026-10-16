import * as THREE from 'three';
import type { AeroContext } from './context.ts';
import type { FlightPath } from './flight.ts';
import { STREETS } from './streets.ts';
import { TAU } from './util.ts';

/** A soap bubble: rises by `rise` m/s and loops back after `range` m (0: hovers in place). */
export interface BubbleSpec { x: number; y: number; z: number; r: number; rise: number; range: number }

interface Bubble extends BubbleSpec { m: THREE.Mesh; y0: number; ph: number }

const bubbleVS = `varying vec3 vN;varying vec3 vV;varying vec3 vWN;void main(){vec4 mv=modelViewMatrix*vec4(position,1.0);vN=normalize(normalMatrix*normal);vV=-mv.xyz;vWN=normal;gl_Position=projectionMatrix*mv;}`;
const bubbleFS = `uniform vec3 uLight;uniform float uTime;varying vec3 vN;varying vec3 vV;varying vec3 vWN;
    void main(){vec3 n=normalize(vN),v=normalize(vV);float ndv=clamp(dot(n,v),0.0,1.0);float f=pow(1.0-ndv,2.2);
      vec3 ir=0.5+0.5*cos(6.2831*(vec3(0.0,0.33,0.67)+f*1.4+vWN.y*0.3+uTime*0.05));
      vec3 c=mix(vec3(0.86,0.95,1.0),ir,0.5);
      vec3 h=normalize(uLight+v);float sp=pow(max(dot(n,h),0.0),180.0)*1.6+pow(max(dot(n,h),0.0),18.0)*0.12;
      vec3 h2=normalize(vec3(-uLight.x,-uLight.y*0.3,uLight.z)+v);float sp2=pow(max(dot(n,h2),0.0),60.0)*0.35;
      float a=f*0.75+0.05+sp+sp2;gl_FragColor=vec4(c*(0.6+f*0.6)+vec3(sp+sp2),clamp(a,0.0,1.0));}`;

/** Iridescent bubbles: the park ones already in `specs`, plus meadow, street and sky bubbles. */
export function buildBubbles(ctx: AeroContext, path: FlightPath, specs: BubbleSpec[]) {
  const { R, rnd, pick } = ctx.random;
  const uLight: THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3() };
  const bubMat = new THREE.ShaderMaterial({
    uniforms: { uLight, uTime: ctx.time }, transparent: true, depthWrite: false,
    vertexShader: bubbleVS, fragmentShader: bubbleFS,
  });
  const BUBBLES: Bubble[] = [];
  const BUBS = specs;
  const bg = new THREE.SphereGeometry(1, 32, 24);
  for (let i = 0; i < 45; i++) { const [x, z] = path.nearMeadow(18); BUBS.push({ x, y: R(0.8, 7), z, r: R(0.4, 2.4), rise: R(0.4, 1.4), range: 24 }); }
  for (let i = 0; i < 18; i++) { const c = pick(STREETS), s = R(-230, 230), ax = rnd() < 0.5; BUBS.push({ x: ax ? c + R(-8, 8) : s, y: R(15, 70), z: ax ? s : c + R(-8, 8), r: R(1, 4), rise: R(1, 3), range: 60 }); }
  const high = path.points.filter((p) => p.y > 120);
  for (let i = 0; i < 22; i++) { const p = pick(high); BUBS.push({ x: p.x + R(-60, 60), y: p.y + R(-20, 30), z: p.z + R(-60, 60), r: R(3, 10), rise: R(0.5, 1.5), range: 50 }); }
  BUBS.push({ x: -330, y: 85, z: 700, r: 75, rise: 0, range: 0 }, { x: 620, y: 150, z: -620, r: 130, rise: 0, range: 0 }, { x: -120, y: 42, z: 860, r: 28, rise: 0, range: 0 });
  for (const b of BUBS) { const m = new THREE.Mesh(bg, bubMat); m.scale.setScalar(b.r); m.position.set(b.x, b.y, b.z); m.renderOrder = 2; ctx.root.add(m); BUBBLES.push(Object.assign(b, { m, y0: b.y, ph: R(0, TAU) })); }

  return {
    /** Needs the camera's matrices for this frame (lit in view space). */
    update(t: number, dt: number, camera: THREE.Camera) {
      uLight.value.copy(ctx.sun).transformDirection(camera.matrixWorldInverse);
      for (const b of BUBBLES) {
        if (b.range) { b.y += b.rise * dt; if (b.y > b.y0 + b.range) b.y = b.y0; }
        b.m.position.set(b.x + Math.sin(t * 0.5 + b.ph) * b.r * 0.6, b.y + (b.range ? 0 : Math.sin(t * 0.3 + b.ph) * 4), b.z + Math.cos(t * 0.4 + b.ph) * b.r * 0.6);
      }
    },
  };
}

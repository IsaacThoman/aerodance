import * as THREE from 'three';
import type { Occluder } from './cityBuilder.ts';
import type { AeroContext } from './context.ts';
import { TAU, canvas2d, col, sstep } from './util.ts';

type FlareTexture = 'disc' | 'ring' | 'hex';

function ringTex(ctx: AeroContext, kind: FlareTexture) {
  const { c, g } = canvas2d(128, 128);
  if (kind === 'hex') { g.translate(64, 64); g.beginPath(); for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU; g.lineTo(Math.cos(a) * 58, Math.sin(a) * 58); } g.closePath(); const gr = g.createRadialGradient(0, 0, 0, 0, 0, 60); gr.addColorStop(0, 'rgba(255,255,255,.25)'); gr.addColorStop(1, 'rgba(255,255,255,.7)'); g.fillStyle = gr; g.fill(); }
  else if (kind === 'ring') { const gr = g.createRadialGradient(64, 64, 40, 64, 64, 62); gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.6, 'rgba(255,255,255,.8)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); }
  else { const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); }
  return ctx.tex(c);
}

/** Ray from o along dir vs the tower bounding boxes. */
function sunBlocked(occluders: readonly Occluder[], o: THREE.Vector3, dir: THREE.Vector3) {
  for (const [x0, x1, y1, z0, z1] of occluders) {
    let tmin = 0, tmax = 1200;
    for (const [o1, d1, a, b] of [[o.x, dir.x, x0, x1], [o.y, dir.y, -1, y1], [o.z, dir.z, z0, z1]]) {
      if (Math.abs(d1) < 1e-6) { if (o1 < a || o1 > b) { tmin = 1; tmax = 0; break; } continue; }
      let t0 = (a - o1) / d1, t1 = (b - o1) / d1; if (t0 > t1) [t0, t1] = [t1, t0];
      tmin = Math.max(tmin, t0); tmax = Math.min(tmax, t1); if (tmin > tmax) break;
    }
    if (tmin <= tmax) return true;
  }
  return false;
}

export interface LensFlare {
  /** Overlay scene, drawn on top of the world in screen space. */
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;
  /** Fades the flare in when the sun is on screen and not behind a tower or cloud. */
  update(dt: number, frame: number, camera: THREE.PerspectiveCamera, cloudAmount: number): void;
}

export function buildLensFlare(ctx: AeroContext, occluders: readonly Occluder[]): LensFlare {
  const SUN = ctx.sun;
  const oScene = new THREE.Scene(), oCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  const FT: Record<FlareTexture, THREE.Texture> = { disc: ringTex(ctx, 'disc'), ring: ringTex(ctx, 'ring'), hex: ringTex(ctx, 'hex') };
  const specs: [k: number, s: number, t: FlareTexture, c: string, o: number][] = [[0.25, 0.08, 'disc', '#bff2ff', 0.35], [0.45, 0.14, 'hex', '#9dffcf', 0.2], [0.7, 0.05, 'disc', '#ffe3a8', 0.35], [1.05, 0.24, 'ring', '#a8d8ff', 0.22], [1.35, 0.11, 'hex', '#d7b3ff', 0.2], [1.7, 0.32, 'ring', '#9fe9ff', 0.13]];
  const FLARES = specs.map(([k, s, t, c, o]) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: FT[t], color: col(c), blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true, opacity: 0 }));
    sp.scale.set(s, s, 1); oScene.add(sp); return { sp, k, o };
  });

  let flareVis = 0, occluded = false;
  const sunNdc = new THREE.Vector3(), fwd = new THREE.Vector3();
  return {
    scene: oScene,
    camera: oCam,
    update(dt, frame, camera, cloudAmt) {
      camera.getWorldDirection(fwd);
      sunNdc.copy(camera.position).addScaledVector(SUN, 1000).project(camera);
      const facing = fwd.dot(SUN) > 0;
      if (frame % 3 === 0) occluded = facing && sunBlocked(occluders, camera.position, SUN);
      const onScreen = facing && Math.abs(sunNdc.x) < 1.3 && Math.abs(sunNdc.y) < 1.3;
      const edge = onScreen ? 1 - sstep(0.6, 1.3, Math.max(Math.abs(sunNdc.x), Math.abs(sunNdc.y))) : 0;
      flareVis += ((onScreen && !occluded ? edge * (1 - cloudAmt) : 0) - flareVis) * Math.min(1, dt * 6);
      for (const f of FLARES) { f.sp.position.set(sunNdc.x * camera.aspect * (1 - f.k), sunNdc.y * (1 - f.k), 0); f.sp.material.opacity = f.o * flareVis; }
    },
  };
}

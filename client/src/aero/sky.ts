import * as THREE from 'three';
import { FOG_BASE, FOG_DENSITY, FOG_WHITE, type AeroContext } from './context.ts';
import type { FlightPath } from './flight.ts';
import { mulberry32 } from './random.ts';
import { TAU, canvas2d, clamp, col, sstep } from './util.ts';

/* ------------------------------------------------------------------- sky */
const skyVS = `varying vec3 vDir;void main(){vDir=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
const skyFS = `
  uniform vec3 sunDir;uniform float env;uniform float uTime;varying vec3 vDir;
  float h21(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
  float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
    return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y);}
  float fbm(vec2 p){float s=0.0,a=0.5;for(int i=0;i<5;i++){s+=a*vn(p);p*=2.03;a*=0.5;}return s;}
  void main(){
    vec3 d=normalize(vDir);float h=d.y;
    vec3 zen=vec3(0.015,0.19,0.80),mid=vec3(0.13,0.50,0.96),hor=vec3(0.80,0.93,1.0);
    vec3 c=mix(hor,mid,smoothstep(0.0,0.28,h));c=mix(c,zen,smoothstep(0.24,0.95,h));
    if(h>0.02){vec2 uv=d.xz/(h+0.18)*1.6+vec2(uTime*0.004,0.0);
      float w=fbm(uv*vec2(0.6,2.4));c=mix(c,vec3(1.0),smoothstep(0.58,0.85,w)*0.38*smoothstep(0.02,0.25,h));}
    if(h<0.0){vec3 g=env>0.5?vec3(0.36,0.62,0.30):hor;c=mix(hor,g,smoothstep(0.0,-0.18,h));}
    float s=max(dot(d,sunDir),0.0);
    c+=vec3(1.0,0.98,0.92)*(pow(s,900.0)*3.0+pow(s,40.0)*0.32+pow(s,6.0)*0.12);
    if(env>0.5)c=pow(c,vec3(2.2));
    gl_FragColor=vec4(c,1.0);
  }`;

function sunTex(ctx: AeroContext) {
  const { c, g } = canvas2d(512, 512);
  const gr = g.createRadialGradient(256, 256, 0, 256, 256, 256);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.06, 'rgba(255,255,250,1)');
  gr.addColorStop(0.16, 'rgba(255,250,230,.55)'); gr.addColorStop(0.4, 'rgba(200,235,255,.12)'); gr.addColorStop(1, 'rgba(200,235,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 512, 512); g.translate(256, 256);
  for (let i = 0; i < 14; i++) {
    g.save(); g.rotate((i / 14) * TAU + (i % 2) * 0.1);
    const L = i % 2 ? 150 : 230, lg = g.createLinearGradient(0, 0, L, 0);
    lg.addColorStop(0, 'rgba(255,255,255,.75)'); lg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = lg; g.beginPath(); g.moveTo(0, -3); g.lineTo(L, 0); g.lineTo(0, 3); g.fill(); g.restore();
  }
  return ctx.tex(c);
}

export interface SkyDome {
  /** Keeps the dome and the sun centred on the camera. */
  follow(camera: THREE.Camera): void;
}

/** Sky dome, the matching environment map for reflections, and the sun glare. */
export function buildSky(ctx: AeroContext): SkyDome {
  const { root, sun: SUN } = ctx;
  const skyMat = (env: boolean) => new THREE.ShaderMaterial({
    uniforms: { sunDir: { value: SUN }, env: { value: env ? 1 : 0 }, uTime: ctx.time },
    vertexShader: skyVS, fragmentShader: skyFS, side: THREE.BackSide, depthWrite: false, fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(5200, 48, 24), skyMat(false));
  sky.renderOrder = -2; root.add(sky);
  {
    const pm = new THREE.PMREMGenerator(ctx.renderer);
    const es = new THREE.Scene();
    const m = new THREE.Mesh(new THREE.SphereGeometry(40, 48, 24), skyMat(true));
    es.add(m);
    ctx.scene.environment = pm.fromScene(es, 0.02, 0.1, 100).texture;
    m.geometry.dispose(); m.material.dispose(); pm.dispose();
  }
  const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTex(ctx), blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true }));
  sunSprite.scale.set(1500, 1500, 1); sunSprite.renderOrder = -1; root.add(sunSprite);
  return {
    follow(camera) {
      sky.position.copy(camera.position);
      sunSprite.position.copy(camera.position).addScaledVector(SUN, 4000);
    },
  };
}

export function buildLights(ctx: AeroContext) {
  const { root } = ctx;
  root.add(new THREE.HemisphereLight(col('#d6ecff'), col('#6fae3c'), 2.2));
  const sunL = new THREE.DirectionalLight(col('#fff6e5'), 3.6);
  sunL.position.copy(ctx.sun).multiplyScalar(700);
  sunL.castShadow = true;
  const shadowSize = ctx.quality.small ? 1024 : 2048;
  sunL.shadow.mapSize.set(shadowSize, shadowSize);
  Object.assign(sunL.shadow.camera, { left: -340, right: 340, top: 340, bottom: -340, near: 1, far: 1700 });
  sunL.shadow.bias = -0.0004; sunL.shadow.normalBias = 0.6;
  root.add(sunL, sunL.target);
}

/* ------------------------------------------------------------------ clouds */
function cloudTex(ctx: AeroContext, seed: number) {
  const S = 256, { c, g } = canvas2d(S, S), rr = mulberry32(seed), r = (a: number, b: number) => a + (b - a) * rr();
  for (let i = 0; i < 28; i++) {
    const x = 128 + r(-78, 78) * (1 - i / 40), y = 150 + r(-40, 25) - Math.max(0, 40 - Math.abs(x - 128) * 0.5) * rr(), rad = r(26, 58);
    const gr = g.createRadialGradient(x, y, 0, x, y, rad); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.55, 'rgba(255,255,255,.85)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  g.globalCompositeOperation = 'source-atop';
  const sh = g.createLinearGradient(0, 80, 0, 210); sh.addColorStop(0, 'rgba(255,255,255,0)'); sh.addColorStop(1, 'rgba(150,178,214,.55)'); g.fillStyle = sh; g.fillRect(0, 0, S, S);
  return ctx.tex(c);
}

export interface Clouds {
  /** Fades nearby clouds, thickens the fog inside cloud banks. */
  update(dt: number, camera: THREE.Camera): void;
  /** 0..1, how deep the camera is inside a cloud bank. */
  readonly amount: number;
}

export function buildClouds(ctx: AeroContext, path: FlightPath): Clouds {
  const { root, fog } = ctx;
  const { R, pick } = ctx.random;
  const Q = ctx.quality.Q;
  const CT = [11, 23, 37, 59].map((seed) => cloudTex(ctx, seed));
  const CLOUDS: { s: THREE.Sprite; m: THREE.SpriteMaterial; base: number }[] = [];
  const CLUSTERS: { p: THREE.Vector3; r: number }[] = [];
  function cluster(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, n: number, size: number, fogR: number) {
    for (let i = 0; i < n; i++) {
      const m = new THREE.SpriteMaterial({ map: pick(CT), transparent: true, depthWrite: false, fog: true, rotation: R(-0.12, 0.12) });
      const s = new THREE.Sprite(m);
      s.position.set(cx + R(-sx, sx), cy + R(-sy, sy), cz + R(-sz, sz));
      const k = size * R(0.6, 1.3); s.scale.set(k, k * 0.72, 1); root.add(s);
      CLOUDS.push({ s, m, base: R(0.82, 1) });
    }
    if (fogR) CLUSTERS.push({ p: new THREE.Vector3(cx, cy, cz), r: fogR });
  }
  const hp = path.curve.getSpacedPoints(70).filter((p) => p.y > 165 && p.y < 300);
  for (const p of hp) cluster(p.x + R(-60, 60), clamp(p.y + R(-25, 10), 190, 262), p.z + R(-60, 60), 45, 14, 45, 5, 75, 55);
  for (let i = 0; i < Math.round(26 * Q + 8); i++) cluster(R(-450, 800), R(200, 250), R(-1000, 350), 150, 22, 150, 6, 120, 0);
  for (let i = 0; i < Math.round(36 * Q + 10); i++) { const a = R(0, TAU), r = R(900, 2400); cluster(Math.cos(a) * r, R(150, 380), Math.sin(a) * r, 160, 40, 160, 5, R(160, 300), 0); }
  for (let i = 0; i < 10; i++) cluster(R(-200, 250), R(110, 150), R(380, 950), 80, 15, 80, 4, 110, 0);

  let cloudAmt = 0;
  return {
    get amount() { return cloudAmt; },
    update(dt, camera) {
      let ca = 0; for (const c of CLUSTERS) ca = Math.max(ca, sstep(c.r * 1.25, c.r * 0.35, c.p.distanceTo(camera.position)));
      cloudAmt += (ca - cloudAmt) * Math.min(1, dt * 3);
      for (const c of CLOUDS) c.m.opacity = c.base * sstep(8, 70, c.s.position.distanceTo(camera.position));
      fog.density = FOG_DENSITY + cloudAmt * 0.011; fog.color.copy(FOG_BASE).lerp(FOG_WHITE, cloudAmt);
    },
  };
}

/* ---------------------------------------------------------- jet + contrail */
export function buildJet(ctx: AeroContext) {
  const jet = new THREE.Group();
  const wm = new THREE.MeshStandardMaterial({ color: col('#ffffff'), metalness: 0.3, roughness: 0.3 });
  const f = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.6, 14, 10), wm); f.rotation.z = Math.PI / 2; jet.add(f);
  jet.add(new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.2, 17), wm));
  const tl = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 0.2), wm); tl.position.set(-6, 1.5, 0); jet.add(tl);
  const { c, g } = canvas2d(256, 8), gr = g.createLinearGradient(0, 0, 256, 0);
  gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.85, 'rgba(255,255,255,.75)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 256, 8);
  const cm = new THREE.MeshBasicMaterial({ map: ctx.tex(c), transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false, opacity: 0.9 });
  for (const oz of [-3.5, 3.5]) for (const r of [0, Math.PI / 2]) { const p = new THREE.Mesh(new THREE.PlaneGeometry(700, 2.2), cm); p.position.set(-352, 0, oz); p.rotation.x = r; jet.add(p); }
  jet.scale.setScalar(3); ctx.root.add(jet);
  return {
    update(t: number) { jet.position.set(((t * 90) % 7000) - 3500, 950, -1900); },
  };
}

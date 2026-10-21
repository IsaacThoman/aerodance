import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { advance, Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { PCFShadowMap } from 'three';
import { loadMotion } from '../../../../packages/character/motion.ts';
import motionUrl from '../../../../packages/character/assets/dance.adpose?url';
import type { MotionTake } from '../../../../packages/pose/motion.ts';
import { STAGES } from '../../../../packages/stages/index.ts';
import type { Stage, StageId } from '../../../../packages/stages/index.ts';
import type { Vec3 } from '../../../../packages/stages/catalog.ts';
import Dancers, { DANCER_LOOKS } from '../../../../packages/stages/shared/Dancers.tsx';
import { post, RenderPipeline, resetPost } from '../../../../packages/stages/shared/post.tsx';
import { drawTitle, titleWidth } from '../../../../apps/web/src/ui/draw.ts';
import { APP_ICONS, SHOTS, SPLASHES, TV_ICONS, assertShot, bufferFor, designFor } from './shots.ts';
import type { DancerPart, FigurePose, FrameBuffer, Shot, ShotCamera as ShotCameraSpec, ShotLayer, ShotLogo, ShotPanel, ThumbnailWindow } from './shots.ts';

/*
 * Renders one thumbnail in-engine: a dance stage, the two captured dancers holding a pose,
 * a hand-placed 3:2 camera, and optionally the title screen's "aerodance." wordmark.
 *
 * The buffer is the game's own pixel grid cropped to 3:2: the game draws 640x480 and shows
 * it at 16:9, so its pixels are 4:3 wide. 540x480 shown at 3:2 has exactly the same pixel
 * size and shape, and the same post-processing (bloom, grade, ACES).
 *
 * The clock is stepped by hand (frameloop="never"): window.__thumb.render() plays the
 * stage forward at 60 fps to the shot's time, then reads back the frame with and
 * without the wordmark, and the shot's layers if it has any. scripts/render.ts drives it
 * and writes the PNGs.
 *
 * URL: ?shot=<id> (SHOTS), ?icon=<id> (TV_ICONS, APP_ICONS), ?splash=<id> (SPLASHES), or ?spec=<JSON>
 * for a one-off shot.
 */

const STEP = 1 / 60;

function shotFromUrl(): Shot {
  const params = new URLSearchParams(window.location.search);
  const spec = params.get('spec');
  if (spec !== null) {
    const shot: unknown = JSON.parse(spec);
    assertShot(shot);
    return shot;
  }
  const icon = params.get('icon');
  if (icon !== null) {
    const shot = [...TV_ICONS, ...APP_ICONS].find((s) => s.id === icon);
    if (!shot) throw new Error(`Unknown icon "${icon}"`);
    return shot;
  }
  const splash = params.get('splash');
  if (splash !== null) {
    const shot = SPLASHES.find((s) => s.id === splash);
    if (!shot) throw new Error(`Unknown splash "${splash}"`);
    return shot;
  }
  return SHOTS.find((s) => s.id === params.get('shot')) ?? SHOTS[0];
}

function stageFor(id: StageId): Stage {
  const stage = STAGES.find((s) => s.meta.id === id);
  if (!stage) throw new Error(`Unknown stage "${id}"`);
  return stage;
}

// The shot's camera, at 3:2, 5:3, 1:1 or 16:9, stands in for the stage's own (orbiting, 16:9) camera:
// it takes over as the default camera whenever the stage sets its own.
function ShotCamera({ position, target, fov = 40, near, far, shift, aspect }: ShotCameraSpec & { aspect: number }) {
  const camera = useMemo(() => {
    // manual: fiber leaves its aspect alone on resize.
    const cam: THREE.PerspectiveCamera & { manual?: boolean } = new THREE.PerspectiveCamera(fov, aspect, near ?? 0.1, far ?? 2000);
    cam.manual = true;
    cam.position.set(...position);
    cam.lookAt(...target);
    // A lens shift: slides the frame without changing the view's angle.
    if (shift) cam.setViewOffset(aspect, 1, shift[0] * aspect, -shift[1], aspect, 1);
    cam.updateMatrixWorld();
    return cam;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useFrame((state) => {
    if (state.camera === camera) return;
    // Keep the stage's depth range unless the shot sets its own.
    camera.near = near ?? state.camera.near;
    camera.far = far ?? state.camera.far;
    camera.updateProjectionMatrix();
    state.set({ camera });
  }, -1);
  return null;
}

// A rig's bones by name, and the cloned model they pose (the Root bone's top ancestor below the mirror).
function rigsIn(dancers: THREE.Object3D) {
  const roots: THREE.Bone[] = [];
  dancers.traverse((o) => { if (o instanceof THREE.Bone && o.name === 'Root') roots.push(o); });
  return roots.map((root) => {
    let model: THREE.Object3D = root;
    while (model.parent && !(model.parent.scale.x < 0)) model = model.parent;
    const bones = new Map<string, THREE.Bone>();
    model.traverse((o) => { if (o instanceof THREE.Bone) bones.set(o.name, o); });
    return { model, bones };
  });
}

// Hand-set poses (FigurePose) held after the capture is applied each frame, before the frame renders.
// A hat rides on the head bone.
function Figures({ dancers, figures }: { dancers: RefObject<THREE.Group | null>; figures: readonly (FigurePose | null | undefined)[] }) {
  const attached = useRef(new Set<THREE.Object3D>());
  const target = useMemo(() => new THREE.Vector3(), []);
  const offset = useMemo(() => new THREE.Vector3(), []);
  const inverse = useMemo(() => new THREE.Matrix4(), []);
  useFrame(() => {
    if (!dancers.current) return;
    rigsIn(dancers.current).forEach(({ model, bones }, person) => {
      const figure = figures[person];
      if (figure === undefined) return;
      if (figure === null) { model.visible = false; return; }
      const bone = (name: string) => bones.get(name)!;
      const [Root, Body, Head] = ['Root', 'Body', 'Head'].map(bone);
      Root.position.set(...(figure.root ?? [0, 0, 0]));
      Root.rotation.set(0, 0, 0);
      Body.rotation.set(...(figure.body ?? [0, 0, 0]));
      Head.rotation.set(...(figure.head ?? [0, 0, 0]));
      model.updateWorldMatrix(true, true);
      const place = (b: THREE.Bone, at: readonly number[], o: readonly number[]) => {
        target.set(at[0], at[1], at[2]).applyMatrix4(model.matrixWorld).applyMatrix4(inverse.copy(b.parent!.matrixWorld).invert());
        offset.set(o[0], o[1], o[2]).applyQuaternion(b.quaternion);
        b.position.copy(target.sub(offset));
        b.updateMatrixWorld(true);
      };
      // The meshes' centres sit these offsets from their bones (retarget.ts).
      ([['ArmL', -1, 0], ['ArmR', 1, 1]] as const).forEach(([name, sign, i]) => {
        const arm = bone(name);
        arm.rotation.set(0, 0, 0);
        arm.updateMatrixWorld(true);
        if (figure.hands) place(arm, figure.hands[i], [sign * 0.26, -0.86, 0]);
      });
      (['FootL', 'FootR'] as const).forEach((name, i) => {
        const foot = bone(name);
        foot.rotation.set(...(figure.footTurn?.[i] ?? [0, 0, 0]));
        foot.updateMatrixWorld(true);
        if (figure.feet) place(foot, figure.feet[i], [0, 0, 0.13]);
      });
      if (figure.hat && !attached.current.has(Head)) {
        attached.current.add(Head);
        Head.add(topHat(figure.hat));
      }
    });
  }, 0.5);
  return null;
}

// Head-bone space: the head's centre is 0.615 above the neck, its top 1.26.
function topHat([pitch, roll]: readonly [number, number]) {
  const felt = new THREE.MeshPhysicalMaterial({ color: '#050507', roughness: 0.42, clearcoat: 0.6, clearcoatRoughness: 0.3, sheen: 0.4, sheenColor: new THREE.Color('#3a3a44') });
  const band = new THREE.MeshPhysicalMaterial({ color: '#16161c', roughness: 0.3, clearcoat: 1 });
  const hat = new THREE.Group();
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.045, 48), felt);
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.31, 0.62, 48), felt);
  crown.position.y = 0.33;
  const ribbon = new THREE.Mesh(new THREE.CylinderGeometry(0.315, 0.315, 0.1, 48), band);
  ribbon.position.y = 0.08;
  hat.add(brim, crown, ribbon);
  hat.traverse((o) => { if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; } });
  // Pivot at the head's centre, then out to its crown.
  const pivot = new THREE.Group();
  pivot.position.y = 0.615;
  pivot.rotation.set(pitch, 0, roll);
  hat.position.y = 0.5;
  pivot.add(hat);
  return pivot;
}


// Shot-wide changes held every frame, over whatever the stage sets: post settings, the
// environment's strength, fog and background, plus any extra spotlights.
function ShotLook({ shot }: { shot: Shot }) {
  const scene = useThree((s) => s.scene);
  const fog = useMemo(() => shot.fog && new THREE.FogExp2(shot.fog.color, shot.fog.density), [shot]);
  const background = useMemo(() => shot.background !== undefined ? new THREE.Color(shot.background) : undefined, [shot]);
  const lights = useMemo(() => (shot.lights ?? []).map((l) => {
    const light = new THREE.SpotLight(l.color ?? '#ffffff', l.intensity, 0, l.angle ?? 0.5, l.penumbra ?? 0.4);
    light.position.set(...l.position);
    light.target.position.set(...l.target);
    if (l.shadow) {
      light.castShadow = true;
      light.shadow.mapSize.set(2048, 2048);
      light.shadow.bias = -0.0004;
      light.shadow.camera.near = 0.5;
      light.shadow.camera.far = 200;
    }
    return light;
  }), [shot]);
  useEffect(() => {
    for (const light of lights) scene.add(light, light.target);
    return () => { for (const light of lights) scene.remove(light, light.target); };
  }, [scene, lights]);
  useFrame(() => {
    if (shot.post) Object.assign(post, shot.post);
    if (shot.environment !== undefined) scene.environmentIntensity = shot.environment;
    if (fog) scene.fog = fog;
    if (background) scene.background = background;
  }, 0.6);
  return null;
}

// Seeded so renders stay deterministic.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTexture(width: number, height: number, draw: (g: CanvasRenderingContext2D, rand: () => number) => void, seed: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d')!, random(seed));
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

// Dark specks and smears, drawn wrapped so the texture still tiles.
function grime(g: CanvasRenderingContext2D, rand: () => number, count: number, size: number, alpha: number) {
  const { width, height } = g.canvas;
  for (let i = 0; i < count; i++) {
    const x = rand() * width, y = rand() * height, r = size * (0.2 + rand() ** 3);
    g.fillStyle = `rgba(0, 0, 0, ${alpha * (0.3 + rand() * 0.7)})`;
    for (const dx of [-width, 0, width]) for (const dy of [-height, 0, height]) {
      g.beginPath();
      g.ellipse(x + dx, y + dy, r, r * (0.5 + rand()), rand() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
  }
}

// Two units of floor, an even number of checkers a side so it tiles.
const floorTexture = (tiles: number, [light, dark]: readonly [string, string], wear: number) => canvasTexture(1024, 1024, (g, rand) => {
  const s = 1024 / tiles;
  // Soft-edged tiles, so the low-res frame doesn't alias them into plaid.
  g.filter = 'blur(4px)';
  g.fillStyle = dark;
  g.fillRect(0, 0, 1024, 1024);
  for (let i = -1; i <= tiles; i++) for (let j = -1; j <= tiles; j++) {
    g.fillStyle = (i + j + 2) % 2 ? dark : light;
    g.fillRect(i * s, j * s, s, s);
  }
  g.filter = 'none';
  g.fillStyle = 'rgba(0, 0, 0, 0.35)';
  for (let i = 0; i <= tiles; i++) { g.fillRect(i * s - 1, 0, 2, 1024); g.fillRect(0, i * s - 1, 1024, 2); }
  grime(g, rand, Math.round(900 * wear), 5, 0.85);
  grime(g, rand, Math.round(40 * wear), 30, 0.12);
}, 7);

// Two units of wall, `height` tall: grimy plaster with drips, and a band of small tiles.
const wallTexture = (height: number, wall: string, [a, b]: readonly [string, string], [bottom, band]: readonly [number, number], wear: number) =>
  canvasTexture(256, Math.round(128 * height), (g, rand) => {
    const px = 128, h = g.canvas.height;
    g.fillStyle = wall;
    g.fillRect(0, 0, 256, h);
    grime(g, rand, Math.round(220 * wear), 26, 0.1);
    for (let i = 0; i < 260 * wear; i++) {
      g.fillStyle = `rgba(255, 255, 255, ${0.03 + rand() * 0.06})`;
      g.fillRect(rand() * 256, rand() * h, 2 + rand() * 18, 2 + rand() * 10);
    }
    // Drips run down from the band.
    for (let i = 0; i < 40 * wear; i++) {
      g.fillStyle = `rgba(0, 0, 0, ${0.08 + rand() * 0.2})`;
      g.fillRect(rand() * 256, h - bottom * px, 1 + rand() * 3, rand() * bottom * px * 0.9);
    }
    const top = h - (bottom + band) * px, rows = 2, s = (band * px) / rows;
    for (let r = 0; r < rows; r++) for (let c = 0; c < Math.ceil(256 / s); c++) {
      g.fillStyle = (r + c) % 2 ? b : a;
      g.fillRect(c * s, top + r * s, s - 1, s - 1);
    }
    g.fillStyle = '#0c0c0c';
    g.fillRect(0, top - 5, 256, 5);
    g.fillRect(0, top + band * px, 256, 5);
    grime(g, rand, Math.round(60 * wear), 8, 0.25);
  }, 11);

// A rectangle from `at` along u then v (u x v is its front), its uvs `at`'s own coordinates
// along each, divided by `unit`, so neighbouring faces line up.
function face(at: Vec3, u: Vec3, v: Vec3, uv: readonly [number, number], unit: readonly [number, number]) {
  const p = new THREE.Vector3(...at), du = new THREE.Vector3(...u), dv = new THREE.Vector3(...v);
  const corners = [p.clone(), p.clone().add(du), p.clone().add(du).add(dv), p.clone().add(dv)];
  const [u0, v0] = [uv[0] / unit[0], uv[1] / unit[1]], [u1, v1] = [u0 + du.length() / unit[0], v0 + dv.length() / unit[1]];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners.flatMap((c) => c.toArray()), 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([u0, v0, u1, v0, u1, v1, u0, v1], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.computeVertexNormals();
  return geometry;
}

// The back room (ShotRoom): floor, back wall, side wall or pillar, cables.
function Room({ room }: { room: NonNullable<Shot['room']> }) {
  const group = useMemo(() => {
    const [width, depth, height] = room.size ?? [8, 6, 4.5];
    const [thick, length] = room.side ?? [0.25, depth];
    const tile = room.tile ?? 0.34;
    const colors = room.colors ?? {};
    const trim = room.trim ?? [1.7, 0.36];
    const wear = room.wear ?? 1;
    const floor = new THREE.MeshPhysicalMaterial({
      map: floorTexture(2 * Math.round(1 / tile), colors.floor ?? ['#d8d8d4', '#111112'], wear),
      roughness: 0.55, clearcoat: room.gloss ?? 0.8, clearcoatRoughness: 0.12,
    });
    const wallMap = wallTexture(height, colors.wall ?? '#77736e', colors.trim ?? ['#2f4a40', '#121614'], trim, wear);
    const wall = new THREE.MeshStandardMaterial({ map: wallMap, roughness: 0.9 });
    const g = new THREE.Group();
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.receiveShadow = mesh.castShadow = true;
      g.add(mesh);
    };
    const ground = 0.003, F = [2, 2] as const, W = [2, height] as const;
    // Floor in front of the back wall, and behind the corner past the side wall.
    add(face([-width, ground, depth * 1.5], [2 * width, 0, 0], [0, 0, -depth * 1.5], [-width, -depth * 1.5], F), floor);
    add(face([thick, ground, 0], [width - thick, 0, 0], [0, 0, -depth], [thick, 0], F), floor);
    // The back wall.
    add(face([-width, 0, 0], [width, 0, 0], [0, height, 0], [-width, 0], W), wall);
    // The side wall: its inner face, front edge and outer face.
    add(face([0, 0, 0], [0, 0, length], [0, height, 0], [0, 0], W), wall);
    add(face([0, 0, length], [thick, 0, 0], [0, height, 0], [length, 0], W), wall);
    add(face([thick, 0, length], [0, 0, -length - depth], [0, height, 0], [length + thick, 0], W), wall);
    // Cables hang from above and trail along the floor by the wall; every other one striped.
    const rand = random(3);
    const rubber = new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.45 });
    const dashes = (repeat: number) => {
      const map = canvasTexture(64, 16, (c) => {
        c.fillStyle = '#141414'; c.fillRect(0, 0, 64, 16);
        c.fillStyle = '#e8e8e8'; c.fillRect(8, 5, 26, 6);
      }, 1);
      map.repeat.set(repeat, 1);
      return new THREE.MeshStandardMaterial({ roughness: 0.4, map });
    };
    (room.cables ?? []).forEach(([left, out], i) => {
      const x = -left, z = out, sway = () => (rand() - 0.5) * 0.6, trail = rand() < 0.5 ? -1 : 1;
      const curve = new THREE.CatmullRomCurve3([
        [x, height + 1, z], [x + sway(), height * 0.62, z + rand() * 0.2], [x + sway(), height * 0.25, z + rand() * 0.3],
        [x + sway(), 0.06, z + 0.3 + rand() * 0.2], [x + trail * (0.8 + rand()), 0.06, z + 0.4 + rand() * 0.3],
      ].map((p) => new THREE.Vector3(...p)));
      const geometry = new THREE.TubeGeometry(curve, 160, 0.035 + rand() * 0.035, 10);
      add(geometry, i % 2 ? dashes(Math.round(curve.getLength() * 4)) : rubber);
    });
    g.position.set(...room.position);
    g.rotation.y = room.rotationY ?? 0;
    return g;
  }, [room]);
  return <primitive object={group} />;
}

// Film grain and scanlines drawn over the finished frame (in the HUD, after post-processing).
function Overlay({ hud, buffer, grain = 0, scanlines = 0 }: { hud: THREE.Scene; buffer: FrameBuffer; grain?: number; scanlines?: number }) {
  useEffect(() => {
    const texture = canvasTexture(buffer.width, buffer.height, (g, rand) => {
      const image = g.createImageData(buffer.width, buffer.height);
      for (let y = 0; y < buffer.height; y++) for (let x = 0; x < buffer.width; x++) {
        // Each pixel is the stronger of its grain (light or dark) and its row's scanline (dark).
        const i = (y * buffer.width + x) * 4, n = rand(), speck = grain * Math.abs(n - 0.5), line = y % 2 ? scanlines * 0.35 : 0;
        image.data[i] = image.data[i + 1] = image.data[i + 2] = n >= 0.5 && speck > line ? 255 : 0;
        image.data[i + 3] = 255 * Math.min(1, Math.max(speck, line));
      }
      g.putImageData(image, 0, 0);
    }, 5);
    texture.magFilter = texture.minFilter = THREE.NearestFilter;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, toneMapped: false }));
    mesh.position.z = -0.5;
    hud.add(mesh);
    return () => { hud.remove(mesh); };
  }, [hud, buffer, grain, scanlines]);
  return null;
}

function Ready({ onReady }: { onReady: () => void }) {
  useLayoutEffect(() => onReady(), [onReady]);
  return null;
}

// The title screen's wordmark on a buffer-sized canvas, laid out in design units and
// drawn over the frame with nearest filtering, exactly as the game's canvas UI draws it.
function makeLogo(logo: ShotLogo, buffer: FrameBuffer) {
  const design = designFor(buffer);
  const canvas = document.createElement('canvas');
  canvas.width = buffer.width;
  canvas.height = buffer.height;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('2D canvas unavailable');
  g.setTransform(buffer.width / design.width, 0, 0, buffer.height / design.height, 0, 0);
  const w = titleWidth(g, logo.size, logo.stacked, logo.light);
  const x = logo.x === 'left' ? 96 : logo.x === 'right' ? design.width - 96 - w : typeof logo.x === 'number' ? logo.x : (design.width - w) / 2;
  drawTitle(g, { x, y: logo.y, size: logo.size, stacked: logo.stacked, outline: logo.outline, halo: logo.halo, light: logo.light });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  return { scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1), context: g };
}

// Captures the scene around `at` (without the dancers) as the reflections it gives, in place of
// the stage's environment map, at `brightness`, with soft light panels added to it alone.
function reflectScene(gl: THREE.WebGLRenderer, scene: THREE.Scene, dancers: THREE.Object3D, at: Vec3, brightness: number,
  panels: readonly ShotPanel[] = []) {
  const pmrem = new THREE.PMREMGenerator(gl);
  const plane = new THREE.PlaneGeometry(1, 1);
  const softboxes = panels.map(({ from, size, color = '#ffffff', intensity }) => {
    // Brighter by 1 / brightness, which the environment's intensity takes back off.
    const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity / brightness), side: THREE.DoubleSide, fog: false });
    const mesh = new THREE.Mesh(plane, material);
    mesh.position.set(at[0] + from[0], at[1] + from[1], at[2] + from[2]);
    mesh.scale.set(size[0], size[1], 1);
    mesh.lookAt(...at);
    scene.add(mesh);
    return mesh;
  });
  dancers.visible = false;
  // Far enough for the sky dome; the same blur as the stages' own environment maps.
  const target = pmrem.fromScene(scene, 0.04, 0.1, 10000, { position: new THREE.Vector3(...at) });
  dancers.visible = true;
  for (const mesh of softboxes) {
    scene.remove(mesh);
    (mesh.material as THREE.Material).dispose();
  }
  plane.dispose();
  pmrem.dispose();
  scene.environment = target.texture;
  scene.environmentIntensity = brightness;
}

// Reads the drawing buffer top-down as RGBA.
function readPixels(gl: THREE.WebGLRenderer, { width, height }: FrameBuffer) {
  const ctx = gl.getContext();
  gl.setRenderTarget(null);
  const pixels = new Uint8Array(width * height * 4);
  ctx.readPixels(0, 0, width, height, ctx.RGBA, ctx.UNSIGNED_BYTE, pixels);
  const flipped = new Uint8Array(pixels.length);
  const row = width * 4;
  for (let y = 0; y < height; y++) flipped.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  return flipped;
}

function base64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const readFrame = (gl: THREE.WebGLRenderer, buffer: FrameBuffer) => base64(readPixels(gl, buffer));

// Bloom spreads light past the edge of whatever is in a layer, so layers are found in renders
// without it. A threshold this high leaves the bloom pass adding zero.
const NO_BLOOM = 1e4;

interface Pass {
  near: number;
  far: number;
  dancers: boolean;
  bloom: boolean;
  /** false: the scenery still hides what's behind it, but draws nothing (for see-through dancers). */
  scenery?: boolean;
  /** Only this part of the dancers draws; the other still casts its shadow. */
  parts?: DancerPart;
  /** Scales the camera's exposure. */
  exposure?: number;
}

// The rig's floating hands are the Arm.L and Arm.R meshes; the body is everything else.
const partOf = (mesh: THREE.Mesh): DancerPart => (mesh.name.startsWith('Arm') ? 'hands' : 'body');

// See-through dancers: drawn alone (the scenery still hides them where it's in front, but draws
// nothing) into a transparent buffer, where the glass leaves its real alpha. The layer then gets
// the frame's grade and tone mapping by itself, and tvOS blends it over the layers behind.
const FinishShader = {
  uniforms: {
    tDiffuse: { value: null } as THREE.IUniform<THREE.Texture | null>,
    toneMappingExposure: { value: 1 },
    uVignette: { value: 0 },
    uAspect: { value: 1 },
    uSaturation: { value: 1 },
    uTint: { value: new THREE.Color(1, 1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  // The colour comes premultiplied (drawn over transparent black): divide the alpha back out,
  // then the pipeline's grade (post.tsx) and ACES, and encode as sRGB.
  fragmentShader: /* glsl */ `
    #include <tonemapping_pars_fragment>
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uAspect;
    uniform float uSaturation;
    uniform vec3 uTint;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (c.a <= 0.0) { gl_FragColor = vec4(0.0); return; }
      c.rgb /= c.a;
      vec2 d = vUv - 0.5;
      d.x *= uAspect;
      c.rgb *= mix(1.0, smoothstep(1.05, 0.3, length(d)), uVignette);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = max(mix(vec3(l), c.rgb, uSaturation), 0.0) * uTint;
      gl_FragColor = vec4(sRGBTransferOETF(vec4(ACESFilmicToneMapping(c.rgb), 1.0)).rgb, min(c.a, 1.0));
    }
  `,
};

function renderSeeThrough(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, buffer: FrameBuffer) {
  const { width, height } = buffer;
  // MSAA like the frame; half float, so the glass's highlights aren't clipped before tone mapping.
  const layer = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, samples: 4 });
  const finished = new THREE.WebGLRenderTarget(width, height);
  const material = new THREE.ShaderMaterial({ ...FinishShader, uniforms: THREE.UniformsUtils.clone(FinishShader.uniforms), depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false });
  Object.assign(material.uniforms, {
    tDiffuse: { value: layer.texture },
    toneMappingExposure: { value: post.exposure },
    uVignette: { value: post.vignette },
    uAspect: { value: buffer.aspect },
    uSaturation: { value: post.saturation },
    uTint: { value: new THREE.Color(...post.tint) },
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const finish = new THREE.Scene();
  finish.add(quad);

  const background = scene.background;
  const clear = { color: gl.getClearColor(new THREE.Color()), alpha: gl.getClearAlpha() };
  scene.background = null;
  gl.setClearColor(0x000000, 0);
  gl.setRenderTarget(layer);
  gl.clear();
  gl.render(scene, camera);
  gl.setRenderTarget(finished);
  gl.render(finish, camera);
  const pixels = new Uint8Array(width * height * 4);
  gl.readRenderTargetPixels(finished, 0, 0, width, height, pixels);
  gl.setRenderTarget(null);
  gl.setClearColor(clear.color, clear.alpha);
  scene.background = background;
  layer.dispose();
  finished.dispose();
  material.dispose();
  quad.geometry.dispose();
  // Top row first.
  const rgba = new Uint8Array(pixels.length);
  const row = width * 4;
  for (let y = 0; y < height; y++) rgba.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  return rgba;
}

// Turns the colour at i into the most transparent colour that, over `under`, gives it back.
function unblend(rgba: Uint8Array, under: Uint8Array, i: number) {
  let alpha = 0;
  for (let c = 0; c < 3; c++) {
    const d = rgba[i + c] - under[i + c];
    alpha = Math.max(alpha, d > 0 ? d / (255 - under[i + c]) : d < 0 ? -d / under[i + c] : 0);
  }
  const a = Math.min(255, Math.ceil(alpha * 255));
  for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(under[i + c] + ((rgba[i + c] - under[i + c]) * 255) / a);
  rgba[i + 3] = a;
}

/**
 * Renders the shot's layers at the current frame (the clock stays put: advance() to the same
 * time again has a zero delta). Each layer's colours come from a normal render of it; which
 * pixels it keeps comes from renders without bloom:
 * - a layer that reaches nearer than the one behind it keeps the pixels where anything lies
 *   between the two near planes: that depth range alone, against an empty render. Both use
 *   the same near plane, so depth precision (and what's hidden by what) matches.
 * - a layer at the same depth (the dancers appearing) keeps the pixels that differ from the
 *   layer behind it.
 */
function renderLayers(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, dancers: THREE.Object3D,
  layers: readonly ShotLayer[], time: number, buffer: FrameBuffer) {
  const materialsOf = (root: THREE.Object3D) => {
    const found = new Set<THREE.Material>();
    root.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Points || o instanceof THREE.Line || o instanceof THREE.Sprite) {
        for (const m of [o.material].flat() as THREE.Material[]) found.add(m);
      }
    });
    return found;
  };
  // Hidden dancers still cast their shadows: the shadow pass ignores colorWrite.
  const materials = new Map([...materialsOf(dancers)].map((m) => [m, m.depthWrite] as const));
  // A part is hidden by giving its meshes a copy of their material that draws nothing (one
  // material is shared by a dancer's parts); the shadow pass ignores colorWrite.
  const meshes = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  dancers.traverse((o) => { if (o instanceof THREE.Mesh) meshes.set(o, o.material); });
  const invisible = new Map<THREE.Material, THREE.Material>();
  const hide = (m: THREE.Material) => {
    let copy = invisible.get(m);
    if (!copy) {
      copy = m.clone();
      copy.colorWrite = false;
      copy.depthWrite = false;
      invisible.set(m, copy);
    }
    return copy;
  };
  const scenery = new Map([...materialsOf(scene)].filter((m) => !materials.has(m)).map((m) => [m, m.colorWrite] as const));
  const { near, far } = camera;
  const setUp = (pass: Pass) => {
    camera.near = pass.near;
    camera.far = pass.far;
    camera.updateProjectionMatrix();
    for (const [m, depthWrite] of materials) {
      m.colorWrite = pass.dancers;
      m.depthWrite = pass.dancers && depthWrite;
    }
    for (const [m, colorWrite] of scenery) m.colorWrite = pass.scenery !== false && colorWrite;
    for (const [mesh, material] of meshes) {
      const shown = !pass.parts || partOf(mesh) === pass.parts;
      mesh.material = shown ? material : Array.isArray(material) ? material.map(hide) : hide(material);
    }
  };
  const draw = (pass: Pass) => {
    setUp(pass);
    const { bloomThreshold, exposure } = post;
    if (!pass.bloom) post.bloomThreshold = NO_BLOOM;
    post.exposure *= pass.exposure ?? 1;
    advance(time);
    Object.assign(post, { bloomThreshold, exposure });
    return readPixels(gl, buffer);
  };
  const differ = (a: Uint8Array, b: Uint8Array, i: number) => a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2];
  const out: { name: string; rgba: Uint8Array }[] = [];
  let behindColor: Uint8Array | null = null;
  layers.forEach((layer, k) => {
    const pass = { near: layer.near ?? near, far, dancers: !!layer.dancers, bloom: false, parts: layer.dancerParts, exposure: layer.exposure };
    const rgba = draw({ ...pass, bloom: true });
    const color = rgba.slice();
    const below = layers[k - 1];
    if (layer.seeThrough) {
      // Over a layer at the same depth without the dancers, or over another see-through part.
      if (!below || (below.near ?? near) !== pass.near || !pass.dancers || (below.dancers && !below.seeThrough)) {
        throw new Error(`Layer "${layer.name}": only a layer that adds the dancers can be see-through`);
      }
      setUp({ ...pass, scenery: false });
      out.push({ name: layer.name, rgba: renderSeeThrough(gl, scene, camera, buffer) });
      behindColor = color;
      return;
    }
    if (below && behindColor) {
      // Part of the dancers doesn't show the other part, which the layer behind may hold, so it's
      // cut against the scene without them instead.
      const behind = pass.parts ? { ...pass, dancers: false, parts: undefined } : { near: below.near ?? near, far, dancers: !!below.dancers, bloom: false };
      const under = pass.parts ? draw({ ...behind, bloom: true }) : behindColor;
      const sliced = pass.near < behind.near;
      const [a, b] = sliced
        ? [draw({ ...pass, far: behind.near }), draw({ ...pass, far: pass.near * 1.0001 })]
        : [draw(pass), draw(behind)];
      for (let i = 0; i < rgba.length; i += 4) {
        rgba[i + 3] = differ(a, b, i) ? 255 : 0;
        // Bloom from this layer spilling onto the one behind (the dancers' glints): keep it as
        // the least alpha that composites over the layer behind back to this colour. Only at
        // the same depth, where the renders differ by nothing else.
        if (!sliced && !rgba[i + 3] && differ(color, under, i)) unblend(rgba, under, i);
      }
    }
    out.push({ name: layer.name, rgba });
    behindColor = color;
  });
  // Leave the scene as it was.
  draw({ near, far, dancers: true, bloom: true });
  for (const copy of invisible.values()) copy.dispose();
  return out;
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

async function until(test: () => boolean, what: string, timeout = 60000) {
  const start = performance.now();
  while (!test()) {
    if (performance.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function Thumbnail({ shot, motion }: { shot: Shot; motion: MotionTake }) {
  const looks = useMemo(() => shot.figures && DANCER_LOOKS.map((look, i) => ({ ...look, ...shot.figures?.[i]?.look })), [shot]);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const size = useThree((s) => s.size);
  const get = useThree((s) => s.get);
  const buffer = bufferFor(shot);
  const dancers = useRef<THREE.Group>(null);
  const { meta, Component: Stage } = stageFor(shot.stage);
  const playback = useRef(shot.pose);
  const hud = useMemo(() => ({ scene: new THREE.Scene(), camera: new THREE.OrthographicCamera() }), []);
  const stageReady = useRef(false);
  const onReady = useCallback(() => { stageReady.current = true; }, []);

  useLayoutEffect(() => {
    gl.setSize(buffer.width, buffer.height, false);
  }, [gl, buffer, size.width, size.height]);
  useLayoutEffect(() => resetPost(meta.post), [meta]);

  useEffect(() => {
    (window as ThumbnailWindow).__thumb = {
      shot,
      renderer: (() => {
        const ctx = gl.getContext();
        const info = ctx.getExtension('WEBGL_debug_renderer_info');
        return String(info ? ctx.getParameter(info.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER));
      })(),
      async render() {
        await until(() => stageReady.current, 'the stage');
        // Both dancers' rigs are in the scene (the model loads in its own Suspense).
        await until(() => scene.getObjectsByProperty('name', 'Root').filter((o) => 'isBone' in o).length >= 2, 'the dancers');
        // The wordmark's two Inter weights (index.html); never fall back to another font.
        if (shot.logo) {
          const faces = await Promise.all(['800', String(shot.logo.light ?? 200)].map((wt) => document.fonts.load(`${wt} 64px Inter`, 'aerodance')));
          if (faces.some((f) => !f.length)) throw new Error('Inter did not load, so the wordmark cannot be drawn');
        }
        await nextTask();
        // Play the stage forward to the shot's time, letting React commit between batches.
        const frames = Math.max(1, Math.round(shot.time / STEP));
        for (let i = 1; i <= frames; i++) {
          advance(i * STEP);
          if (i % 20 === 0) await nextTask();
        }
        if (shot.reflections !== undefined) {
          if (!dancers.current) throw new Error('The dancers are missing');
          reflectScene(gl, scene, dancers.current, shot.camera.target, shot.reflections, shot.panels);
          advance(frames * STEP); // the same frame again, with them
        }
        const plain = readFrame(gl, buffer);
        let logo: string | null = null;
        let wordmark: Uint8Array | null = null;
        if (shot.logo) {
          const layer = makeLogo(shot.logo, buffer);
          gl.autoClear = false;
          gl.clearDepth();
          gl.render(layer.scene, layer.camera);
          gl.autoClear = true;
          logo = readFrame(gl, buffer);
          wordmark = new Uint8Array(layer.context.getImageData(0, 0, buffer.width, buffer.height).data.buffer);
        }
        let layers: { name: string; rgba: string }[] | null = null;
        if (shot.layers) {
          const camera = get().camera;
          if (!(camera instanceof THREE.PerspectiveCamera) || !dancers.current) throw new Error('The shot camera or dancers are missing');
          const rendered = shot.layers.filter((layer) => !layer.wordmark);
          // Hidden layers are rendered, so the layer above is cut against them, but left out.
          const parts = renderLayers(gl, scene, camera, dancers.current, rendered, frames * STEP, buffer).filter((_, i) => !rendered[i].hidden);
          if (wordmark) {
            // On top, unless a wordmark entry puts it lower.
            const kept = shot.layers.filter((layer) => !layer.hidden);
            const at = kept.findIndex((layer) => layer.wordmark);
            parts.splice(at < 0 ? parts.length : at, 0, { name: at < 0 ? 'logo' : kept[at].name, rgba: wordmark });
          }
          layers = parts.map(({ name, rgba }) => ({ name, rgba: base64(rgba) }));
        }
        return { width: buffer.width, height: buffer.height, plain, logo, layers };
      },
    };
  }, [gl, scene, get, shot, buffer]);

  return (
    <>
      <RenderPipeline hudScene={hud.scene} hudCamera={hud.camera} width={buffer.width} height={buffer.height} aspect={buffer.aspect} />
      <ShotCamera {...shot.camera} aspect={buffer.aspect} />
      <Suspense fallback={null}>
        {shot.hideStage ? <group visible={false}><Stage /></group> : <Stage />}
        <Ready onReady={onReady} />
      </Suspense>
      <group ref={dancers}>
        <Dancers motion={motion} playback={playback} {...meta.dancers} {...shot.dancers} looks={looks} />
      </group>
      {shot.figures && <Figures dancers={dancers} figures={shot.figures} />}
      <ShotLook shot={shot} />
      {shot.room && <Room room={shot.room} />}
      {shot.overlay && <Overlay hud={hud.scene} buffer={buffer} {...shot.overlay} />}
    </>
  );
}

export default function App() {
  const shot = useMemo(shotFromUrl, []);
  const [motion, setMotion] = useState<MotionTake | null>(null);
  useEffect(() => {
    fetch(motionUrl)
      .then((r) => r.arrayBuffer())
      .then((bytes) => setMotion(loadMotion(bytes)));
  }, []);
  return (
    <div className="frame">
      {motion && (
        <Canvas
          frameloop="never"
          dpr={1}
          shadows={{ type: PCFShadowMap }}
          camera={{ position: [0, 4.2, 13.5], fov: 40, aspect: bufferFor(shot).aspect }}
          gl={{ antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' }}
        >
          <Thumbnail shot={shot} motion={motion} />
        </Canvas>
      )}
    </div>
  );
}

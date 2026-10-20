import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { advance, Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { PCFShadowMap } from 'three';
import { loadMotion } from '../../../../packages/character/motion.ts';
import motionUrl from '../../../../packages/character/assets/dance.adpose?url';
import type { MotionTake } from '../../../../packages/pose/motion.ts';
import { STAGES } from '../../../../packages/stages/index.ts';
import type { Stage, StageId } from '../../../../packages/stages/index.ts';
import Dancers from '../../../../packages/stages/shared/Dancers.tsx';
import { post, RenderPipeline, resetPost } from '../../../../packages/stages/shared/post.tsx';
import { drawTitle, titleWidth } from '../../../../client/src/ui/draw.ts';
import { SHOTS, TV_ICONS, assertShot, bufferFor, designFor } from './shots.ts';
import type { FrameBuffer, Shot, ShotCamera as ShotCameraSpec, ShotLayer, ShotLogo, ThumbnailWindow } from './shots.ts';

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
 * URL: ?shot=<id> (SHOTS), ?icon=<id> (TV_ICONS), or ?spec=<JSON> for a one-off shot.
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
    const shot = TV_ICONS.find((s) => s.id === icon);
    if (!shot) throw new Error(`Unknown icon "${icon}"`);
    return shot;
  }
  return SHOTS.find((s) => s.id === params.get('shot')) ?? SHOTS[0];
}

function stageFor(id: StageId): Stage {
  const stage = STAGES.find((s) => s.meta.id === id);
  if (!stage) throw new Error(`Unknown stage "${id}"`);
  return stage;
}

// The shot's camera, at 3:2 or 5:3, stands in for the stage's own (orbiting, 16:9) camera:
// it takes over as the default camera whenever the stage sets its own.
function ShotCamera({ position, target, fov = 40, near, far, aspect }: ShotCameraSpec & { aspect: number }) {
  const camera = useMemo(() => {
    // manual: fiber leaves its aspect alone on resize.
    const cam: THREE.PerspectiveCamera & { manual?: boolean } = new THREE.PerspectiveCamera(fov, aspect, near ?? 0.1, far ?? 2000);
    cam.manual = true;
    cam.position.set(...position);
    cam.lookAt(...target);
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
  const w = titleWidth(g, logo.size);
  const x = logo.x === 'left' ? 96 : logo.x === 'right' ? design.width - 96 - w : typeof logo.x === 'number' ? logo.x : (design.width - w) / 2;
  drawTitle(g, { x, y: logo.y, size: logo.size });

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

interface Pass { near: number; far: number; dancers: boolean; bloom: boolean; }

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
function renderLayers(gl: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, dancers: THREE.Object3D,
  layers: readonly ShotLayer[], time: number, buffer: FrameBuffer) {
  // Hidden dancers still cast their shadows: the shadow pass ignores colorWrite.
  const materials = new Map<THREE.Material, boolean>();
  dancers.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    for (const m of [o.material].flat() as THREE.Material[]) materials.set(m, m.depthWrite);
  });
  const { near, far } = camera;
  const draw = (pass: Pass) => {
    camera.near = pass.near;
    camera.far = pass.far;
    camera.updateProjectionMatrix();
    for (const [m, depthWrite] of materials) {
      m.colorWrite = pass.dancers;
      m.depthWrite = pass.dancers && depthWrite;
    }
    const threshold = post.bloomThreshold;
    if (!pass.bloom) post.bloomThreshold = NO_BLOOM;
    advance(time);
    post.bloomThreshold = threshold;
    return readPixels(gl, buffer);
  };
  const differ = (a: Uint8Array, b: Uint8Array, i: number) => a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2];
  const out: { name: string; rgba: Uint8Array }[] = [];
  let behindColor: Uint8Array | null = null;
  layers.forEach((layer, k) => {
    const pass = { near: layer.near ?? near, far, dancers: !!layer.dancers, bloom: false };
    const rgba = draw({ ...pass, bloom: true });
    const color = rgba.slice();
    const below = layers[k - 1];
    if (below && behindColor) {
      const behind = { near: below.near ?? near, far, dancers: !!below.dancers, bloom: false };
      const sliced = pass.near < behind.near;
      const [a, b] = sliced
        ? [draw({ ...pass, far: behind.near }), draw({ ...pass, far: pass.near * 1.0001 })]
        : [draw(pass), draw(behind)];
      for (let i = 0; i < rgba.length; i += 4) {
        rgba[i + 3] = differ(a, b, i) ? 255 : 0;
        // Bloom from this layer spilling onto the one behind (the dancers' glints): keep it as
        // the least alpha that composites over the layer behind back to this colour. Only at
        // the same depth, where the renders differ by nothing else.
        if (!sliced && !rgba[i + 3] && differ(color, behindColor, i)) unblend(rgba, behindColor, i);
      }
    }
    out.push({ name: layer.name, rgba });
    behindColor = color;
  });
  // Leave the scene as it was.
  draw({ near, far, dancers: true, bloom: true });
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
          const faces = await Promise.all(['800', '200'].map((wt) => document.fonts.load(`${wt} 64px Inter`, 'aerodance')));
          if (faces.some((f) => !f.length)) throw new Error('Inter did not load, so the wordmark cannot be drawn');
        }
        await nextTask();
        // Play the stage forward to the shot's time, letting React commit between batches.
        const frames = Math.max(1, Math.round(shot.time / STEP));
        for (let i = 1; i <= frames; i++) {
          advance(i * STEP);
          if (i % 20 === 0) await nextTask();
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
          const parts = renderLayers(gl, camera, dancers.current, shot.layers, frames * STEP, buffer);
          if (wordmark) parts.push({ name: 'logo', rgba: wordmark });
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
        <Stage />
        <Ready onReady={onReady} />
      </Suspense>
      <group ref={dancers}>
        <Dancers motion={motion} playback={playback} {...meta.dancers} {...shot.dancers} />
      </group>
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

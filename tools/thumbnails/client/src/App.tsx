import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { advance, Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { PCFShadowMap } from 'three';
import { loadMotion } from '../../../../packages/character/motion.ts';
import motionUrl from '../../../../packages/character/assets/dance.adpose?url';
import type { MotionTake } from '../../../../packages/pose/legacy.ts';
import { STAGES } from '../../../../packages/stages/index.ts';
import type { Stage, StageId } from '../../../../packages/stages/index.ts';
import Dancers from '../../../../packages/stages/shared/Dancers.tsx';
import { RenderPipeline, resetPost } from '../../../../packages/stages/shared/post.tsx';
import { drawTitle, titleWidth } from '../../../../client/src/ui/draw.ts';
import { BUFFER, DESIGN, SHOTS, assertShot } from './shots.ts';
import type { Shot, ShotCamera as ShotCameraSpec, ShotLogo, ThumbnailWindow } from './shots.ts';

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
 * without the wordmark. scripts/render.ts drives it and writes the PNGs.
 *
 * URL: ?shot=<id> (shots.ts), or ?spec=<JSON> for a one-off shot.
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
  return SHOTS.find((s) => s.id === params.get('shot')) ?? SHOTS[0];
}

function stageFor(id: StageId): Stage {
  const stage = STAGES.find((s) => s.meta.id === id);
  if (!stage) throw new Error(`Unknown stage "${id}"`);
  return stage;
}

// The shot's camera, at 3:2, stands in for the stage's own (orbiting, 16:9) camera:
// it takes over as the default camera whenever the stage sets its own.
function ShotCamera({ position, target, fov = 40, near, far }: ShotCameraSpec) {
  const camera = useMemo(() => {
    // manual: fiber leaves its aspect alone on resize.
    const cam: THREE.PerspectiveCamera & { manual?: boolean } = new THREE.PerspectiveCamera(fov, BUFFER.aspect, near ?? 0.1, far ?? 2000);
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

// The title screen's wordmark on a buffer-sized canvas, laid out in 3:2 design units and
// drawn over the frame with nearest filtering, exactly as the game's canvas UI draws it.
function makeLogo(logo: ShotLogo) {
  const canvas = document.createElement('canvas');
  canvas.width = BUFFER.width;
  canvas.height = BUFFER.height;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('2D canvas unavailable');
  g.setTransform(BUFFER.width / DESIGN.width, 0, 0, BUFFER.height / DESIGN.height, 0, 0);
  const w = titleWidth(g, logo.size);
  const x = logo.x === 'left' ? 96 : logo.x === 'right' ? DESIGN.width - 96 - w : typeof logo.x === 'number' ? logo.x : (DESIGN.width - w) / 2;
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
  return { scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1) };
}

// Reads the drawing buffer top-down as base64 RGBA.
function readFrame(gl: THREE.WebGLRenderer) {
  const ctx = gl.getContext();
  const { width, height } = BUFFER;
  gl.setRenderTarget(null);
  const pixels = new Uint8Array(width * height * 4);
  ctx.readPixels(0, 0, width, height, ctx.RGBA, ctx.UNSIGNED_BYTE, pixels);
  const flipped = new Uint8Array(pixels.length);
  const row = width * 4;
  for (let y = 0; y < height; y++) flipped.set(pixels.subarray((height - 1 - y) * row, (height - y) * row), y * row);
  let binary = '';
  for (let i = 0; i < flipped.length; i += 0x8000) binary += String.fromCharCode(...flipped.subarray(i, i + 0x8000));
  return btoa(binary);
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
  const { meta, Component: Stage } = stageFor(shot.stage);
  const playback = useRef(shot.pose);
  const hud = useMemo(() => ({ scene: new THREE.Scene(), camera: new THREE.OrthographicCamera() }), []);
  const stageReady = useRef(false);
  const onReady = useCallback(() => { stageReady.current = true; }, []);

  useLayoutEffect(() => {
    gl.setSize(BUFFER.width, BUFFER.height, false);
  }, [gl, size.width, size.height]);
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
        const plain = readFrame(gl);
        let logo: string | null = null;
        if (shot.logo) {
          const layer = makeLogo(shot.logo);
          gl.autoClear = false;
          gl.clearDepth();
          gl.render(layer.scene, layer.camera);
          gl.autoClear = true;
          logo = readFrame(gl);
        }
        return { width: BUFFER.width, height: BUFFER.height, plain, logo };
      },
    };
  }, [gl, scene, shot]);

  return (
    <>
      <RenderPipeline hudScene={hud.scene} hudCamera={hud.camera} width={BUFFER.width} height={BUFFER.height} aspect={BUFFER.aspect} />
      <ShotCamera {...shot.camera} />
      <Suspense fallback={null}>
        <Stage />
        <Ready onReady={onReady} />
      </Suspense>
      <Dancers motion={motion} playback={playback} {...meta.dancers} {...shot.dancers} />
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
          camera={{ position: [0, 4.2, 13.5], fov: 40, aspect: BUFFER.aspect }}
          gl={{ antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' }}
        >
          <Thumbnail shot={shot} motion={motion} />
        </Canvas>
      )}
    </div>
  );
}

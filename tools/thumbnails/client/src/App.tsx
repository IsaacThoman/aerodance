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
import { APP_ICONS, SHOTS, TV_ICONS, assertShot, bufferFor, designFor } from './shots.ts';
import type { DancerPart, FrameBuffer, Shot, ShotCamera as ShotCameraSpec, ShotLayer, ShotLogo, ThumbnailWindow } from './shots.ts';

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
 * URL: ?shot=<id> (SHOTS), ?icon=<id> (TV_ICONS, APP_ICONS), or ?spec=<JSON> for a one-off shot.
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

import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { tickBeat } from './hooks.ts';

declare global {
  interface Window {
    /** Development only: the last frame's renderer counts. */
    __aeroStats?: THREE.WebGLInfo['render'] & { geometries: number; textures: number };
  }
}

export interface PostSettings {
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  exposure: number;
  toneMapping: THREE.ToneMapping;
  vignette: number;
  saturation: number;
  tint: readonly [r: number, g: number, b: number];
}

/** A stage's changes to the defaults (StageMeta.post). */
export type PostOverrides = Partial<PostSettings>;

export const RENDER_WIDTH = 640;
export const RENDER_HEIGHT = 480;

// The glass dancers were tuned under ACES, so every stage keeps it. Bloom runs on
// linear HDR before tone mapping: lit surfaces brighter than the threshold glow too.
export const POST_DEFAULTS: Readonly<PostSettings> = {
  bloomStrength: 0.3,
  bloomRadius: 0.45,
  bloomThreshold: 2.0,
  exposure: 1,
  toneMapping: THREE.ACESFilmicToneMapping,
  vignette: 0.2,
  saturation: 1.08,
  tint: [1, 1, 1],
};

// Live post-processing settings. Stages may mutate these every frame
// (for example to pulse bloom on the beat); the host resets them per stage.
export const post: PostSettings = { ...POST_DEFAULTS };

export function resetPost(overrides: PostOverrides = {}): void {
  Object.assign(post, POST_DEFAULTS, overrides);
}

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null } as THREE.IUniform<THREE.Texture | null>,
    uVignette: { value: 0.2 },
    uAspect: { value: 16 / 9 },
    uSaturation: { value: 1 },
    uTint: { value: new THREE.Color(1, 1, 1) },
    // A split screen's grid (columns, rows): each view gets a vignette of its own.
    uGrid: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uAspect;
    uniform float uSaturation;
    uniform vec3 uTint;
    uniform vec2 uGrid;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = fract(vUv * uGrid) - 0.5;
      d.x *= uAspect * uGrid.y / uGrid.x;
      float v = smoothstep(1.05, 0.3, length(d));
      c.rgb *= mix(1.0, v, uVignette);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = max(mix(vec3(l), c.rgb, uSaturation), 0.0) * uTint;
      // Opaque: the canvas would blend the page behind it into any alpha below 1 a stage left.
      gl_FragColor = vec4(c.rgb, 1.0);
    }
  `,
};

type GradeUniforms = typeof GradeShader.uniforms;

/**
 * A split screen: an ArrayCamera whose cameras are views, each drawing its own cell of a grid
 * over the frame (`grid`: columns and rows), in reading order from the top left. Rendered by
 * RenderPipeline (ViewsRenderPass), with each view culled and sorted for itself.
 */
export class SplitCamera extends THREE.ArrayCamera {
  readonly isSplitCamera = true;
  grid: readonly [columns: number, rows: number];
  constructor(cameras: THREE.PerspectiveCamera[], grid: readonly [columns: number, rows: number] = splitGrid(cameras.length)) {
    super(cameras);
    this.grid = grid;
  }
}

/** The grid n views split the frame into: side by side up to two, then two by two. */
export function splitGrid(views: number): readonly [columns: number, rows: number] {
  return views <= 2 ? [Math.max(1, views), 1] : [2, Math.ceil(views / 2)];
}

/** A view's cell in the frame, as fractions of it from the bottom left (as viewports go). */
export function splitCell(grid: readonly [number, number], i: number) {
  const [columns, rows] = grid, column = i % columns, row = Math.floor(i / columns);
  return { x: column / columns, y: 1 - (row + 1) / rows, w: 1 / columns, h: 1 / rows };
}

const isSplitCamera = (camera: THREE.Camera): camera is SplitCamera => (camera as Partial<SplitCamera>).isSplitCamera === true;

/**
 * The scene pass, which also draws a split screen: given a SplitCamera, each of its views draws
 * its own cell of the buffer. (three's own ArrayCamera rendering culls and sorts for the parent
 * camera, which is wrong when the views look different ways.) Shadow maps are drawn once, for
 * the first view: they don't depend on the camera.
 */
class ViewsRenderPass extends RenderPass {
  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, deltaTime: number, maskActive: boolean) {
    const camera = this.camera;
    if (!isSplitCamera(camera) || this.renderToScreen) {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      return;
    }
    const saved = { autoClear: renderer.autoClear, shadows: renderer.shadowMap.autoUpdate };
    const { width, height } = readBuffer;
    renderer.autoClear = false;
    renderer.setRenderTarget(readBuffer);
    renderer.clear();
    readBuffer.scissorTest = true;
    camera.cameras.forEach((view, i) => {
      const cell = splitCell(camera.grid, i);
      const x = Math.round(cell.x * width), y = Math.round(cell.y * height);
      const w = Math.round((cell.x + cell.w) * width) - x, h = Math.round((cell.y + cell.h) * height) - y;
      readBuffer.viewport.set(x, y, w, h);
      readBuffer.scissor.set(x, y, w, h);
      renderer.setRenderTarget(readBuffer);
      if (i > 0) renderer.shadowMap.autoUpdate = false;
      renderer.render(this.scene, view);
    });
    readBuffer.viewport.set(0, 0, width, height);
    readBuffer.scissor.set(0, 0, width, height);
    readBuffer.scissorTest = false;
    renderer.setRenderTarget(readBuffer);
    renderer.shadowMap.autoUpdate = saved.shadows;
    renderer.autoClear = saved.autoClear;
  }
}

// OutputPass's define for each tone mapping (it builds them from the renderer when it renders).
const OUTPUT_TONE_DEFINES: Partial<Record<THREE.ToneMapping, string>> = {
  [THREE.LinearToneMapping]: 'LINEAR_TONE_MAPPING',
  [THREE.ReinhardToneMapping]: 'REINHARD_TONE_MAPPING',
  [THREE.CineonToneMapping]: 'CINEON_TONE_MAPPING',
  [THREE.ACESFilmicToneMapping]: 'ACES_FILMIC_TONE_MAPPING',
  [THREE.AgXToneMapping]: 'AGX_TONE_MAPPING',
  [THREE.NeutralToneMapping]: 'NEUTRAL_TONE_MAPPING',
  [THREE.CustomToneMapping]: 'CUSTOM_TONE_MAPPING',
};

export interface RenderPipelineProps {
  /** Drawn after post-processing, on top. */
  hudScene?: THREE.Scene;
  hudCamera?: THREE.Camera;
  /** Render-buffer overrides; otherwise follow the renderer's drawing buffer. */
  width?: number;
  height?: number;
  /** The frame the buffer is displayed at. */
  aspect?: number;
  /** MSAA samples for the scene (0: none). */
  samples?: number;
  /** false leaves bloom out whatever the stage asks for (cheaper on weak GPUs). */
  bloom?: boolean;
  /** false draws nothing: the stage is mounted, but something else has the screen. */
  enabled?: boolean;
  /** Checked every frame on top of `enabled`, for a hand-over that can't wait for a render. */
  isEnabled?: () => boolean;
  /** The live settings it reads every frame (default: the stages' `post`). */
  settings?: PostSettings;
}

/**
 * Takes over rendering: stage -> bloom -> grade -> tone mapping, then the HUD
 * layer (optional) on top without post-processing so its text stays crisp.
 * width/height override the renderer's drawing buffer; aspect: the frame it is displayed at.
 * It renders the scene and camera of the store it is mounted in, so inside a
 * createPortal it draws that portal's stage. A SplitCamera draws a split screen.
 */
export function RenderPipeline({
  hudScene, hudCamera, width, height, aspect, samples = 4, bloom: bloomOn = true, enabled = true, isEnabled, settings = post,
}: RenderPipelineProps) {
  const gl = useThree((s) => s.gl);

  const fx = useMemo(() => {
    const target = new THREE.WebGLRenderTarget(width ?? 1, height ?? 1, {
      type: THREE.HalfFloatType,
      samples,
    });
    const composer = new EffectComposer(gl, target);
    // RenderPass draws the scene into rt2 with MSAA and depth. Grade writes
    // only a fullscreen quad into rt1; grade + output swap twice, so the scene
    // keeps rt2 every frame. rt1 needs neither MSAA nor a depth attachment.
    composer.renderTarget1.samples = 0;
    composer.renderTarget1.depthBuffer = false;
    composer.setPixelRatio(1);
    composer.setSize(width ?? 1, height ?? 1);
    const render = new ViewsRenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
    const bloom = new UnrealBloomPass(new THREE.Vector2(width ?? 1, height ?? 1), 0.5, 0.5, 0.8);
    const grade = new ShaderPass(GradeShader);
    // ShaderPass clones GradeShader.uniforms, so its uniforms have the same shape.
    const gradeUniforms = grade.uniforms as GradeUniforms;
    const output = new OutputPass();
    composer.addPass(render);
    composer.addPass(bloom);
    composer.addPass(grade);
    composer.addPass(output);
    return { composer, render, bloom, grade, gradeUniforms, output, buffer: new THREE.Vector2(), width: width ?? 1, height: height ?? 1 };
  }, [gl, width, height, samples]);

  useEffect(
    () => () => {
      fx.composer.dispose();
      fx.bloom.dispose();
      fx.grade.dispose();
      fx.output.dispose();
    },
    [fx],
  );

  // Mounted out of sight (a stage being prepared): start compiling the passes' shaders, so the
  // first frame on screen doesn't stall on them; with KHR_parallel_shader_compile the GPU finishes
  // them in the background. Bloom and grade draw into render targets; the output pass draws to the
  // screen with the stage's tone mapping, and its defines are set the way OutputPass sets them.
  useEffect(() => {
    if (enabled) return undefined;
    const { bloom, grade, output } = fx;
    // Like the passes' own full-screen quad: positions and uvs only (normals change the program).
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).deleteAttribute('normal'));
    const scene = new THREE.Scene().add(quad);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const saved = { target: gl.getRenderTarget(), toneMapping: gl.toneMapping };
    try {
      gl.setRenderTarget(fx.composer.renderTarget1);
      for (const material of [bloom.materialHighPassFilter, ...bloom.separableBlurMaterials, bloom.compositeMaterial, bloom.blendMaterial, grade.material]) {
        quad.material = material;
        gl.compile(scene, camera);
      }
      gl.setRenderTarget(null);
      gl.toneMapping = settings.toneMapping;
      const defines: Record<string, string> = {};
      if (THREE.ColorManagement.getTransfer(gl.outputColorSpace) === THREE.SRGBTransfer) defines.SRGB_TRANSFER = '';
      const tone = OUTPUT_TONE_DEFINES[settings.toneMapping];
      if (tone) defines[tone] = '';
      output.material.defines = defines;
      output.material.needsUpdate = true;
      quad.material = output.material;
      gl.compile(scene, camera);
    } catch (error) {
      console.warn('[post] precompile failed:', error);
    } finally {
      gl.setRenderTarget(saved.target);
      gl.toneMapping = saved.toneMapping;
    }
    return () => quad.geometry.dispose();
  }, [fx, gl, enabled, settings]);

  useFrame((state, delta) => {
    if (!enabled || (isEnabled && !isEnabled())) return;
    tickBeat(Math.min(delta, 0.1));
    const { composer, render, bloom, gradeUniforms } = fx;
    gl.getDrawingBufferSize(fx.buffer);
    const w = width ?? fx.buffer.x, h = height ?? fx.buffer.y;
    if (fx.width !== w || fx.height !== h) {
      composer.setSize(w, h);
      fx.width = w;
      fx.height = h;
    }
    render.scene = state.scene;
    render.camera = state.camera;
    bloom.enabled = bloomOn && settings.bloomStrength > 0;
    bloom.strength = settings.bloomStrength;
    bloom.radius = settings.bloomRadius;
    bloom.threshold = settings.bloomThreshold;
    gradeUniforms.uVignette.value = settings.vignette;
    gradeUniforms.uAspect.value = aspect ?? state.size.width / Math.max(1, state.size.height);
    gradeUniforms.uSaturation.value = settings.saturation;
    gradeUniforms.uTint.value.setRGB(...settings.tint);
    const grid = isSplitCamera(state.camera) ? state.camera.grid : [1, 1] as const;
    gradeUniforms.uGrid.value.set(grid[0], grid[1]);
    gl.toneMapping = settings.toneMapping;
    gl.toneMappingExposure = settings.exposure;
    gl.info.autoReset = false;
    gl.info.reset();
    composer.render(delta);
    if (import.meta.env.DEV) {
      window.__aeroStats = {
        ...gl.info.render,
        geometries: gl.info.memory.geometries,
        textures: gl.info.memory.textures,
      };
    }

    if (hudScene && hudCamera) {
      gl.autoClear = false;
      gl.clearDepth();
      gl.render(hudScene, hudCamera);
    }
    gl.autoClear = true;
  }, 1);

  return null;
}

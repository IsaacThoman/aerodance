import { Component, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import Character from '../../../../packages/character/Character.tsx';
import type { CharacterAppearance } from '../../../../packages/character/Character.tsx';
import type { Pose, TrackCalibration } from '../../../../packages/pose/choreography.ts';
import { DANCER_LOOKS } from '../../../../packages/stages/shared/Dancers.tsx';
import { StageEnvironment } from '../../../../packages/stages/shared/Environment.tsx';
import { POST_DEFAULTS, RenderPipeline, SplitCamera, splitCell } from '../../../../packages/stages/shared/post.tsx';
import type { PostOverrides, PostSettings } from '../../../../packages/stages/shared/post.tsx';
import { diagnostic } from '../diagnostics.ts';
import { displayDesign } from '../display.ts';
import { screenOwner } from '../screenOwner.ts';
import type { Rect } from '../ui/draw.ts';
import { useMinigameSession } from './hooks.ts';
import { cameraArea } from './cameraArea.ts';

/*
 * What a game can draw in 3D, inside the game's one <Canvas> (at its render resolution):
 *
 *   <MinigameWorld>       a world of its own (scene 'custom'): it takes the screen, the menu's
 *                         background stands down, and it draws through the stages' post-processing
 *                         (bloom, grade, ACES) with a fixed camera
 *   <MinigameLayer>       3D things over the menu background or a backdrop (scene 'menu' or
 *                         { background }), with their own camera and a studio light for glass
 *   <MirrorCharacters>    every player's glass character where they stand in the camera's picture,
 *                         over the screen like a mirror (the pose API's screen space, cameraArea)
 *   <LiveCharacter>       one player's glass character, copying them, to place in a world, a layer
 *                         or on a stage (scene { stage }: the game is mounted inside the stage's scene)
 *   <SeenBy>              things a split-screen world (MinigameWorld's `views`) draws in some views
 *                         only: a first-person player's own body, kept out of their own eyes
 *
 * The camera's picture is 4:3 and the screen 16:9 or 4:3: cameraArea fits one to the other, and
 * toDesign / fromDesign map the pose API's screen points (pose/body.ts) to design units and back.
 *
 * Performance: the Apple TV holds 60 fps with a stage's 60-130 draw calls and 0.2-0.8M triangles
 * (packages/stages/README.md). Each glass character is about a dozen draw calls; keep a world in
 * the stages' budget and share materials and geometry (instance repeated things).
 */

export { cameraArea, fromDesign, toDesign } from './cameraArea.ts';

export interface MinigameCameraProps {
  position?: readonly [number, number, number];
  target?: readonly [number, number, number];
  fov?: number;
  near?: number;
  far?: number;
}

// A camera set up as the props say, for a view of this shape (width over height, in design units).
function setUpCamera(camera: THREE.PerspectiveCamera, { position = [0, 1.6, 7], target = [0, 1.2, 0], fov = 40, near = 0.1, far = 500 }: MinigameCameraProps, aspect: number) {
  Object.assign(camera, { fov, near, far, aspect });
  camera.position.set(...position);
  camera.lookAt(...target);
  camera.updateProjectionMatrix();
}

// A perspective camera for the display's shape (anamorphic 16:9 in the same buffer), looking at target.
// It's the only view, so it sees what view 0 does (SeenBy).
function useSceneCamera(props: MinigameCameraProps) {
  const size = useThree((s) => s.size);
  const design = displayDesign(size.width, size.height);
  const camera = useMemo(() => new THREE.PerspectiveCamera(), []);
  const { position = [0, 1.6, 7], target = [0, 1.2, 0], fov = 40, near = 0.1, far = 500 } = props;
  useLayoutEffect(() => {
    setUpCamera(camera, { position, target, fov, near, far }, design.w / design.h);
    camera.layers.enable(VIEW_LAYER);
  }, [camera, fov, near, far, design.w, design.h, ...position, ...target]); // eslint-disable-line react-hooks/exhaustive-deps
  return camera;
}

/** The first of the layers SeenBy puts things on: view i sees VIEW_LAYER + i (and layer 0, as every camera does). */
const VIEW_LAYER = 8;
/** The most views a split screen has (a two by two grid). */
const MAX_VIEWS = 4;

// A split screen's camera (two or more views; null for fewer): its views set up as their props
// say, each shaped for its cell of the grid and seeing its own layer.
function useSplitCamera(views: readonly MinigameCameraProps[] | undefined) {
  const size = useThree((s) => s.size);
  const design = displayDesign(size.width, size.height);
  const count = views && views.length > 1 ? Math.min(views.length, MAX_VIEWS) : 0;
  const split = useMemo(() => (count ? new SplitCamera(Array.from({ length: count }, () => new THREE.PerspectiveCamera())) : null), [count]);
  const key = JSON.stringify(views ?? null);
  useLayoutEffect(() => {
    if (!split || !views) return;
    split.cameras.forEach((view, i) => {
      const cell = splitCell(split.grid, i);
      setUpCamera(view, views[i], (design.w * cell.w) / (design.h * cell.h));
      view.layers.set(0);
      view.layers.enable(VIEW_LAYER + i);
    });
  }, [split, key, design.w, design.h]); // eslint-disable-line react-hooks/exhaustive-deps
  return split;
}

/**
 * View i of a world's camera (useThree's, inside a MinigameWorld): one of a split screen's views,
 * or the camera itself when there's only the one.
 */
export function viewCamera(camera: THREE.Camera, i: number): THREE.Camera {
  return camera instanceof SplitCamera ? camera.cameras[Math.min(i, camera.cameras.length - 1)] : camera;
}

export interface MinigameWorldProps {
  camera?: MinigameCameraProps;
  /** The sky behind everything. */
  background?: THREE.ColorRepresentation;
  /** Changes to the stages' post-processing (bloom, exposure, vignette, saturation, tint). */
  post?: PostOverrides;
  /** Shadows from lights that cast them (they cost a pass each). */
  shadows?: boolean;
  /** The reflections glass shows (default the studio's, StageEnvironment preset="room"); false when the world brings its own. */
  environment?: ReactNode;
  /**
   * A split screen: a camera for each view (two to four), set up as `camera` would be. Two sit
   * side by side, left to right; three or four make a two by two grid, in reading order. Inside,
   * useThree's camera is then a SplitCamera (packages/stages/shared/post.tsx) whose `cameras`
   * are the views (viewCamera(camera, i)); fly each one. Every view draws the whole world, so
   * each costs its draw calls again (shadow maps are drawn once). `camera` is then unused.
   */
  views?: readonly MinigameCameraProps[];
  children?: ReactNode;
}

/**
 * The game's own world (scene 'custom'), drawn through the stages' pipeline at priority 1 while
 * the menu's background stands down (screenOwner.ts). Inside, useThree's camera is the world's;
 * move it from a game frame to fly it. Studio reflections for glass unless it brings its own
 * (`environment`). `views` splits the screen.
 */
export function MinigameWorld({ camera: cameraProps = {}, background = '#a8dcff', post, shadows = false, environment, views, children }: MinigameWorldProps) {
  const gl = useThree((s) => s.gl);
  const scene = useMemo(() => new THREE.Scene(), []);
  const single = useSceneCamera(cameraProps);
  const camera = useSplitCamera(views) ?? single;
  const settings = useMemo<PostSettings>(() => ({ ...POST_DEFAULTS, ...post }), [post]);
  useEffect(() => { scene.background = new THREE.Color(background); }, [scene, background]);
  // Borrows the renderer's settings while it has the screen, as a dance stage does (stage/StageView.tsx).
  useLayoutEffect(() => {
    const saved = { toneMapping: gl.toneMapping, exposure: gl.toneMappingExposure, shadow: { enabled: gl.shadowMap.enabled, type: gl.shadowMap.type, autoUpdate: gl.shadowMap.autoUpdate } };
    Object.assign(gl.shadowMap, { enabled: shadows, type: THREE.PCFShadowMap, autoUpdate: true });
    screenOwner.stage = true;
    return () => {
      Object.assign(gl, { toneMapping: saved.toneMapping, toneMappingExposure: saved.exposure });
      Object.assign(gl.shadowMap, saved.shadow);
      gl.shadowMap.needsUpdate = true;
      screenOwner.stage = false;
    };
  }, [gl, shadows]);
  return createPortal(
    <>
      <PortalCamera camera={camera} />
      <RenderPipeline samples={0} bloom={!diagnostic('nobloom')} settings={settings} />
      {environment ?? <StageEnvironment preset="room" />}
      {children}
    </>,
    scene,
    { camera },
  );
}

export interface SeenByProps {
  /** The views (MinigameWorld's `views`, by index) that draw these; a world with one view is view 0. */
  views: readonly number[];
  children?: ReactNode;
}

/**
 * Its children, drawn only in some of a split screen's views: a first-person player's own body,
 * say, which the other players see but which would fill its owner's view from inside. Its things
 * go on the views' own layers (whatever they load later included), and cast no shadows: shadow
 * maps are drawn once, for all the views, so a shadow can't be for some of them only. Give
 * anything whose shadow matters a stand-in outside that draws nothing (colorWrite: false) but
 * casts it.
 */
export function SeenBy({ views, children }: SeenByProps) {
  const group = useRef<THREE.Group>(null);
  const mask = views.reduce((m, i) => m | (1 << (VIEW_LAYER + i)), 0);
  useFrame(() => {
    group.current?.traverse((o) => {
      o.layers.mask = mask;
      o.castShadow = false;
    });
  });
  return <group ref={group}>{children}</group>;
}

// The portal takes the camera it was made with; a camera that changes later (a world splitting,
// or its views' count changing) is handed to it.
function PortalCamera({ camera }: { camera: THREE.PerspectiveCamera }) {
  const set = useThree((s) => s.set);
  const current = useThree((s) => s.camera);
  useLayoutEffect(() => { if (current !== camera) set({ camera }); }, [camera, current, set]);
  return null;
}

export interface MinigameLayerProps {
  camera?: MinigameCameraProps;
  /** Studio reflections for glass (default on). */
  environment?: boolean;
  /** useFrame priority: after the background (1), before the overlays (2). */
  priority?: number;
  children?: ReactNode;
}

/**
 * 3D things over whatever is behind the game, with their own camera: drawn after it (depth
 * cleared) in ACES like the menu dancers, without post-processing. Lit by a hemisphere and a key
 * light, and the studio environment.
 */
export function MinigameLayer({ camera: cameraProps = {}, environment = true, priority = 1.5, children }: MinigameLayerProps) {
  const gl = useThree((s) => s.gl);
  const scene = useMemo(() => new THREE.Scene(), []);
  const camera = useSceneCamera(cameraProps);
  useFrame(() => {
    const ac = gl.autoClear, tm = gl.toneMapping;
    gl.autoClear = false;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.clearDepth();
    gl.render(scene, camera);
    gl.toneMapping = tm;
    gl.autoClear = ac;
  }, priority);
  return createPortal(
    <>
      {environment && <StageEnvironment preset="room" />}
      <hemisphereLight args={['#d9faff', '#489789', 1.3]} />
      <directionalLight position={[-6, 12, 8]} intensity={2.5} />
      {children}
    </>,
    scene,
    { camera },
  );
}

// Glass characters in the players' colours, solid enough to read over a busy background.
const LOOKS: readonly CharacterAppearance[] = DANCER_LOOKS.map((look) => ({ ...look, opacity: 0.9 }));

class Quiet extends Component<{ children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.warn('[minigames] a character could not load', error); }
  render() { return this.state.failed ? null : this.props.children; }
}

// A player's live pose and calibration each frame (before anything draws).
function useLivePlayer(player: number): [RefObject<Pose | null>, TrackCalibration | null] {
  const session = useMinigameSession();
  const pose = useRef<Pose | null>(null);
  const [calibration, setCalibration] = useState<TrackCalibration | null>(null);
  useFrame(() => {
    const c = session.calibration(player);
    if (c !== calibration) setCalibration(c);
    pose.current = session.livePose(player, performance.now());
  }, -1);
  return [pose, calibration];
}

export interface LiveCharacterProps {
  player: number;
  /** Copies the player like a mirror (their right hand is on the right of the screen; default), or as seen from behind. */
  mirror?: boolean;
  appearance?: CharacterAppearance;
}

/**
 * One player's glass character copying them live, standing at its group's origin (the floor), a
 * torso about 1.05 units long, facing +z. Hidden while the player is missing or uncalibrated.
 *
 * <group position={[x, 0, z]}><LiveCharacter player={0} /></group>
 */
export function LiveCharacter({ player, mirror = true, appearance }: LiveCharacterProps) {
  const [poseRef, calibration] = useLivePlayer(player);
  if (!calibration) return null;
  return (
    <group scale={[mirror ? -1 : 1, 1, 1]}>
      <Quiet>
        <Suspense fallback={null}>
          <Character poseRef={poseRef} calibration={calibration} appearance={appearance ?? LOOKS[player % LOOKS.length]} live />
        </Suspense>
      </Quiet>
    </group>
  );
}

// The applier stands the ankles this far above the character's origin, and scales a calibrated
// torso to this many character units (as game/MirrorDancers.tsx). The character is a legless
// blob: where a person's hips would be is this far up its body.
const ANKLE_HEIGHT = 0.3;
const TORSO = 1.05;
const HIPS_UP = 1.0;

function MirrorCharacter({ player, anchor }: { player: number; anchor: RefObject<THREE.Group | null> }) {
  const [poseRef, calibration] = useLivePlayer(player);
  return (
    <group ref={anchor} visible={false}>
      {calibration && <Character poseRef={poseRef} calibration={calibration} appearance={LOOKS[player % LOOKS.length]} live />}
    </group>
  );
}

export interface MirrorCharactersProps {
  /** How the camera's picture fits the screen (cameraArea): the same fit maps poses for the game. */
  fit?: 'cover' | 'contain';
  /** Draw them inside this design-unit rect instead of the whole screen. */
  rect?: Rect;
  /** Smaller (or bigger) than the player, about their hips: the glass characters' big heads and hands can crowd the screen. */
  scale?: number;
  /**
   * 'hips' (default) lays each character over its player, its body where their hips are, so its
   * hands come near theirs; 'floor' stands it on the floor under them, little and legless, as the
   * song game's mirror does.
   */
  anchor?: 'hips' | 'floor';
  /** false leaves them out (the round's results, say). */
  visible?: boolean;
  priority?: number;
}

/**
 * Every player's glass character where they stand in the camera's picture, fitted to the screen
 * (or rect) like a mirror: a player's hands are where toDesign puts their pose's hands. Each in
 * their colour, drawn one over another so players standing together don't interleave.
 */
export function MirrorCharacters({ fit = 'cover', rect, scale = 1, anchor = 'hips', visible = true, priority = 1.55 }: MirrorCharactersProps) {
  const session = useMinigameSession();
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);
  const scene = useMemo(() => new THREE.Scene(), []);
  const camera = useMemo(() => new THREE.OrthographicCamera(0, 1600, 0, -900, -2000, 2000), []);
  const anchors = useMemo((): RefObject<THREE.Group | null>[] => Array.from({ length: session.playerCount }, () => ({ current: null })), [session]);
  const shown = useRef({ visible, scale, anchor });
  shown.current = { visible, scale, anchor };
  useFrame(() => {
    if (!shown.current.visible || diagnostic('noui')) return;
    const { w, h } = displayDesign(size.width, size.height);
    const input = session.followers.map((_, id) => session.calibration(id)).find(Boolean);
    if (!input) return;
    const area = cameraArea(rect?.w ?? w, rect?.h ?? h, input.inputWidth / input.inputHeight, fit);
    area.x += rect?.x ?? 0;
    area.y += rect?.y ?? 0;
    if (camera.right !== w || camera.bottom !== -h) {
      camera.right = w;
      camera.bottom = -h;
      camera.updateProjectionMatrix();
    }
    const ac = gl.autoClear, tm = gl.toneMapping;
    gl.autoClear = false;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    if (rect) {
      const buffer = gl.getSize(new THREE.Vector2());
      gl.setScissorTest(true);
      gl.setScissor((rect.x / w) * buffer.x, (1 - (rect.y + rect.h) / h) * buffer.y, (rect.w / w) * buffer.x, (rect.h / h) * buffer.y);
    }
    anchors.forEach((anchor, id) => {
      const calibration = session.calibration(id), a = anchor.current;
      if (!a || !calibration) return;
      // One character unit is the calibrated torso, over TORSO, in the picture's height; the
      // origin sits under the calibrated hip, on the floor (scaled about the hip). Mirrored, like
      // the setup preview.
      const k = shown.current.scale, unit = (calibration.torsoLength / TORSO) * area.h * k;
      const hipY = area.y + calibration.baseHip.y * area.h;
      const originY = shown.current.anchor === 'hips' ? hipY + HIPS_UP * unit
        : hipY + (area.y + calibration.floorY * area.h + (ANKLE_HEIGHT * unit) / k - hipY) * k;
      a.position.set(area.x + (1 - calibration.baseHip.x) * area.w, -originY, 0);
      a.scale.set(-unit, unit, unit);
      anchors.forEach((other, i) => { if (other.current) other.current.visible = i === id; });
      gl.clearDepth();
      gl.render(scene, camera);
    });
    anchors.forEach((anchor) => { if (anchor.current) anchor.current.visible = false; });
    gl.setScissorTest(false);
    gl.toneMapping = tm;
    gl.autoClear = ac;
  }, priority);
  return createPortal(
    <>
      <StageEnvironment preset="room" />
      <hemisphereLight args={['#d9faff', '#489789', 1.3]} />
      <directionalLight position={[-6, 12, 8]} intensity={2.5} />
      <Quiet>
        <Suspense fallback={null}>
          {anchors.map((anchor, id) => <MirrorCharacter key={id} player={id} anchor={anchor} />)}
        </Suspense>
      </Quiet>
    </>,
    scene,
    { camera },
  );
}

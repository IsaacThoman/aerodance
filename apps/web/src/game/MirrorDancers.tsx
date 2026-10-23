import { Component, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import Character from '../../../../packages/character/Character.tsx';
import type { Pose, TrackCalibration } from '../../../../packages/pose/choreography.ts';
import { DANCER_LOOKS } from '../../../../packages/stages/shared/Dancers.tsx';
import type { Rect } from '../ui/draw.ts';
import type { GameSession } from './GameSession.ts';
import { PLAYERS } from './results.ts';

/*
 * The mirror's dancers (GameScreen draws the glass around them): each player's aero character
 * copying their live pose, cut out flat in their colour (every mesh drawn in one unlit colour,
 * so only the shape is left). They stand where the players do in the camera's frame, fitted
 * under the strip along the mirror's top, and are mirrored like the setup preview (player 1 on
 * the left). Drawn in their own scene with a camera in design units, just after the overlay
 * (priority 2.05) and clipped to the mirror.
 *
 * <MirrorDancers session={session} view={ref} />  // ref.current: MirrorView, or null to hide them
 */

/** Where and how GameScreen shows the mirror this frame. */
export interface MirrorView {
  /** The mirror in design units, with the strip `top` tall along its top. */
  rect: Rect & { top: number };
  /** The design size. */
  w: number;
  h: number;
  /** How far the pause veil covers them (0-1). */
  dim: number;
  /** The overlay's opacity. */
  alpha: number;
}

// The applier stands the ankles on the floor this far above the character's origin.
const ANKLE_HEIGHT = 0.3;
// And scales a calibrated torso to this many character units.
const TORSO = 1.05;
const VEIL = new THREE.Color('#00183c');
const LOOKS = DANCER_LOOKS.map((look) => ({ ...look, opacity: 1 }));

class Quiet extends Component<{ children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: unknown) { console.warn('Mirror dancers could not load', err); }
  render() { return this.state.failed ? null : this.props.children; }
}

interface MirrorDancerProps { id: number; session: GameSession; anchor: RefObject<THREE.Group | null>; }

function MirrorDancer({ id, session, anchor }: MirrorDancerProps) {
  const poseRef = useRef<Pose | null>(null);
  const [calibration, setCalibration] = useState<TrackCalibration | null>(null);
  useFrame(() => {
    const c = session.live[id]?.calibration ?? null;
    if (c !== calibration) setCalibration(c);
    poseRef.current = session.livePose(id, performance.now());
  }, -1);
  return (
    <group ref={anchor} visible={false}>
      {calibration && <Character poseRef={poseRef} calibration={calibration} appearance={LOOKS[id]} />}
    </group>
  );
}

export default function MirrorDancers({ session, view }: { session: GameSession; view: RefObject<MirrorView | null> }) {
  const gl = useThree((state) => state.gl);
  const scene = useMemo(() => new THREE.Scene(), []);
  const camera = useMemo(() => new THREE.OrthographicCamera(0, 1600, 0, -900, -1000, 1000), []);
  const cutout = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false }), []);
  scene.overrideMaterial = cutout;
  useEffect(() => () => cutout.dispose(), [cutout]);
  const anchors = useMemo((): RefObject<THREE.Group | null>[] => Array.from({ length: session.playerCount }, () => ({ current: null })), [session]);
  const size = useMemo(() => new THREE.Vector2(), []);

  useFrame(() => {
    const v = view.current;
    if (!v || v.alpha < 0.005) return;
    const { rect, w, h } = v;
    // The camera's frame (its size from any calibration), fitted under the strip.
    const input = session.live.find((p) => p.calibration)?.calibration;
    if (!input) return;
    const area = { x: rect.x, y: rect.y + rect.top, w: rect.w, h: rect.h - rect.top };
    const fit = Math.min(area.w / input.inputWidth, area.h / input.inputHeight);
    const dw = input.inputWidth * fit, dh = input.inputHeight * fit;
    const dx = area.x + (area.w - dw) / 2, dy = area.y + (area.h - dh) / 2;

    if (camera.right !== w || camera.bottom !== -h) {
      camera.right = w;
      camera.bottom = -h;
      camera.updateProjectionMatrix();
    }
    gl.getSize(size);
    const ac = gl.autoClear;
    gl.autoClear = false;
    gl.setScissorTest(true);
    gl.setScissor((rect.x / w) * size.x, (1 - (rect.y + rect.h) / h) * size.y, (rect.w / w) * size.x, (rect.h / h) * size.y);
    cutout.opacity = v.alpha;
    // One player at a time, each in their own colour, and each whole over the last: players
    // standing in the same place shouldn't interleave.
    anchors.forEach((anchor, id) => {
      const calibration = session.live[id]?.calibration;
      const a = anchor.current;
      if (!a || !calibration) return;
      // One character unit is the calibrated torso, over TORSO, in the frame's height; the
      // origin sits under the calibrated hip, on the floor.
      const unit = (calibration.torsoLength / TORSO) * dh;
      a.position.set(dx + (1 - calibration.baseHip.x) * dw, -(dy + calibration.floorY * dh + ANKLE_HEIGHT * unit), 0);
      // Mirrored, like the setup preview.
      a.scale.set(-unit, unit, unit);
      cutout.color.set(PLAYERS[id].light).lerp(VEIL, v.dim);
      anchors.forEach((other, i) => { if (other.current) other.current.visible = i === id; });
      gl.clearDepth();
      gl.render(scene, camera);
    });
    anchors.forEach((anchor) => { if (anchor.current) anchor.current.visible = false; });
    gl.setScissorTest(false);
    gl.autoClear = ac;
  }, 2.05);

  return createPortal(
    <Quiet>
      <Suspense fallback={null}>
        {anchors.map((anchor, id) => <MirrorDancer key={id} id={id} session={session} anchor={anchor} />)}
      </Suspense>
    </Quiet>,
    scene,
  );
}

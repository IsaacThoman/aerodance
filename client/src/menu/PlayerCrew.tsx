import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { createPortal, useFrame, useLoader, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import Character from '../../../packages/character/Character.tsx';
import type { CharacterAppearance } from '../../../packages/character/Character.tsx';
import { validateMotion } from '../../../packages/character/motion.ts';
import type { MotionTake } from '../../../packages/pose/legacy.ts';
import modelUrl from '../../../packages/character/assets/aero-character.glb?url';
import motionUrl from '../../../packages/character/assets/dance.json?url';
import { Environment, Quiet } from './MenuDancers.tsx';
import { CREW, PLAYER_COLORS } from './layout.ts';

/**
 * The players screen's four Frutiger characters, one per player in blue, purple, green and
 * pink, standing in the CREW slots under the player-count dial (menu/MainMenu.tsx). The
 * first `count` of them dance at full strength; the rest idle as faint ghosts.
 *
 * They get their own scene with an orthographic camera in the menu's 1600x900 design units,
 * so each one lines up with its slot. Drawn after the menu dancers and before the menu
 * (useFrame priority 1.6), and only mounted while the players screen is up.
 *
 * <PlayerCrew visible count={2} />
 */

const APPEARANCES: readonly CharacterAppearance[] = PLAYER_COLORS.map((color) => ({ color, gloss: 85, accessory: 'None' }));
// Figure height in design units, a little shorter than its slot.
const FIGURE_H = CREW[0].h * 0.92;
// Opacity of the players not picked yet.
const GHOST = 0.45;
// Players three and four dance the capture a beat later than one and two.
const LAG = [0, 0, 3.5, 3.5];

interface CrewProps {
  motion: MotionTake | null;
  count: number;
  opacity: RefObject<number>[];
  playback: RefObject<number>[];
}

function Crew({ motion, count, opacity, playback }: CrewProps) {
  const { scene } = useLoader(GLTFLoader, modelUrl);
  const fit = useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene);
    const scale = FIGURE_H / (box.max.y - box.min.y);
    return { scale, foot: box.min.y * scale };
  }, [scene]);
  return CREW.map((slot, i) => {
    const on = i < count && !!motion;
    return (
      <group
        key={i}
        position={[slot.x + slot.w / 2, -(slot.y + slot.h) - fit.foot, 0]}
        scale={[-fit.scale, fit.scale, fit.scale]}
      >
        {/* A fresh character when it switches between dancing and idling, so no pose carries over. */}
        <Character
          key={on ? 'dance' : 'idle'}
          motion={on ? motion : null}
          person={i % 2}
          playback={playback[i]}
          appearance={APPEARANCES[i]}
          opacityRef={opacity[i]}
        />
      </group>
    );
  });
}

export interface PlayerCrewProps {
  visible?: boolean;
  /** How many players are picked (the first `count` characters dance). */
  count?: number;
}

export default function PlayerCrew({ visible = false, count = 1 }: PlayerCrewProps) {
  const gl = useThree((state) => state.gl);
  const [motion, setMotion] = useState<MotionTake | null>(null);
  const [mounted, setMounted] = useState(visible);
  const stage = useMemo(() => new THREE.Scene(), []);
  const cam = useMemo(() => {
    const c = new THREE.OrthographicCamera(0, 1600, 0, -900, 0.1, 2000);
    c.position.z = 500;
    return c;
  }, []);
  const shown = useRef(0);
  const opacity = useMemo(() => CREW.map(() => ({ current: 0 })), []);
  const playback = useMemo(() => CREW.map(() => ({ current: 0 })), []);
  const clock = useRef(0);
  const still = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);

  useEffect(() => { if (visible) setMounted(true); }, [visible]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(motionUrl, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Dance capture unavailable');
        return response.json();
      })
      .then((data) => setMotion(validateMotion(data)))
      .catch((e: unknown) => { if (!(e instanceof Error && e.name === 'AbortError')) console.warn('Player characters could not load', e); });
    return () => controller.abort();
  }, []);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    shown.current += ((visible ? 1 : 0) - shown.current) * Math.min(1, dt * (visible ? 4 : 8));
    if (!visible && shown.current < 0.005) {
      shown.current = 0;
      if (mounted) setMounted(false);
      return;
    }
    if (!still) clock.current += dt;
    opacity.forEach((o, i) => {
      const target = shown.current * (i < count ? 1 : GHOST);
      o.current += (target - o.current) * Math.min(1, dt * 8);
      playback[i].current = clock.current + LAG[i];
    });
  }, 0.5);

  useFrame(() => {
    if (!mounted || shown.current < 0.005) return;
    const ac = gl.autoClear;
    const tm = gl.toneMapping;
    gl.autoClear = false;
    // Same gel look as the menu dancers (tuned under ACES).
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.clearDepth();
    gl.render(stage, cam);
    gl.toneMapping = tm;
    gl.autoClear = ac;
  }, 1.6);

  if (!mounted) return null;
  return createPortal(
    <>
      <Environment scene={stage} />
      <hemisphereLight args={['#d9faff', '#489789', 1.3]} />
      <directionalLight position={[-6, 12, 8]} intensity={2.5} />
      <Quiet>
        <Suspense fallback={null}>
          <Crew motion={motion} count={count} opacity={opacity} playback={playback} />
        </Suspense>
      </Quiet>
    </>,
    stage,
  );
}

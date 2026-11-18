import { useRef } from 'react';
import type { ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { StageId } from '../../../../../packages/stages/catalog.ts';
import { useDisposable } from '../../../../../packages/stages/shared/hooks.ts';
import { FONT, TAU } from '../../ui/draw.ts';
import { clockHands, clockText, useClockTexture } from '../kit.ts';
import type { ScreensaverContext } from '../types.ts';

/*
 * Dance Party's clock in the scene (the Clock setting's In scene), one that belongs on each stage,
 * placed in the stage's own coordinates clear of the dancers, readable from the stage's shot and
 * the wide one:
 *
 *   club        the time in glowing LED digits on the video wall above the DJ
 *   sanctuary   a glossy glass clock floating over the terrace's pool
 *   atrium      a station clock hanging from the gallery round the aquarium column
 *   openreef    a big air bubble drifting over the reef with the time inside it
 *   beach       a ship's clock in a lifebuoy, on a post in the sand
 *   falls       a clock flower in the meadow, kin to the stage's solar flowers
 */

type V3 = readonly [number, number, number];

/** A canvas texture painted once. */
function useCanvasTexture(width: number, height: number, paint: (g: CanvasRenderingContext2D, w: number, h: number) => void) {
  return useDisposable(() => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    if (g) paint(g, width, height);
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  });
}

const glossy = (color: string, extra: THREE.MeshPhysicalMaterialParameters = {}) =>
  new THREE.MeshPhysicalMaterial({ color, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.05, ...extra });

// ------------------------------------------------------------ analog clocks

interface FaceStyle {
  /** The dial's colours: centre, edge. */
  dial: readonly [string, string];
  ink: string;
  /** Minute marks as well as the hours. */
  minutes?: boolean;
  /** 12, 3, 6 and 9 in figures. */
  figures?: boolean;
}

/** A clock face: a soft gradient dial, bold hour bars (and minute ticks), maybe four figures. */
function paintFace({ dial, ink, minutes = true, figures = false }: FaceStyle) {
  return (g: CanvasRenderingContext2D, w: number) => {
    const c = w / 2;
    const grad = g.createRadialGradient(c, c * 0.8, 0, c, c, c);
    grad.addColorStop(0, dial[0]);
    grad.addColorStop(1, dial[1]);
    g.fillStyle = grad;
    g.fillRect(0, 0, w, w);
    g.strokeStyle = ink;
    g.fillStyle = ink;
    g.lineCap = 'round';
    for (let i = 0; i < 60; i++) {
      const hour = i % 5 === 0;
      if (!hour && !minutes) continue;
      const a = (i / 60) * TAU;
      const r0 = c * (hour ? 0.7 : 0.84), r1 = c * 0.9;
      g.lineWidth = hour ? w * 0.034 : w * 0.009;
      g.beginPath();
      g.moveTo(c + Math.sin(a) * r0, c - Math.cos(a) * r0);
      g.lineTo(c + Math.sin(a) * r1, c - Math.cos(a) * r1);
      g.stroke();
    }
    if (figures) {
      g.font = `700 ${Math.round(w * 0.13)}px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      ['12', '3', '6', '9'].forEach((s, i) => {
        const a = (i / 4) * TAU, r = c * 0.5;
        g.fillText(s, c + Math.sin(a) * r, c - Math.cos(a) * r + w * 0.008);
      });
    }
  };
}

/** The Aero shine over a glass front: a bright crescent across the top, fading down. */
function paintGloss(g: CanvasRenderingContext2D, w: number) {
  const c = w / 2;
  g.save();
  g.beginPath();
  g.ellipse(c, c * 0.62, c * 0.82, c * 0.5, 0, 0, TAU);
  g.clip();
  const grad = g.createLinearGradient(0, c * 0.12, 0, c * 1.1);
  grad.addColorStop(0, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, w);
  g.restore();
}

/** A tapered hand from `-tail` to `length` (pointing up, +y), `depth` thick. */
function handGeometry(length: number, width: number, tail: number, depth: number) {
  const s = new THREE.Shape();
  s.moveTo(-width / 2, -tail);
  s.lineTo(width / 2, -tail);
  s.lineTo(width * 0.28, length);
  s.lineTo(-width * 0.28, length);
  s.closePath();
  return new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: depth * 0.3, bevelSize: width * 0.12, bevelSegments: 2 });
}

interface DialProps {
  face: FaceStyle;
  /** Hour and minute hands' colour, and the second hand's. */
  hands: readonly [string, string];
}

/**
 * An analog clock of radius 1 facing +z: the dial, glossy hands telling the real time, a domed
 * glass front with a shine. Its mount (a bezel, a case, a lifebuoy, petals) is the stage's.
 */
function Dial({ face, hands }: DialProps) {
  const dial = useCanvasTexture(512, 512, paintFace(face));
  const shine = useCanvasTexture(256, 256, paintGloss);
  const parts = useDisposable(() => {
    // The glass: a shallow cap of a sphere, its rim on the dial's edge.
    const cap = 0.42, R = 1 / Math.sin(cap);
    return {
      dial: new THREE.CircleGeometry(1, 64),
      hour: handGeometry(0.5, 0.11, 0.12, 0.03).translate(0, 0, 0.02),
      minute: handGeometry(0.78, 0.075, 0.14, 0.03).translate(0, 0, 0.06),
      second: handGeometry(0.84, 0.03, 0.22, 0.02).translate(0, 0, 0.1),
      hub: new THREE.SphereGeometry(0.065, 16, 10).scale(1, 1, 0.6).translate(0, 0, 0.13),
      glass: new THREE.SphereGeometry(R, 48, 8, 0, TAU, 0, cap).rotateX(Math.PI / 2).translate(0, 0, -R * Math.cos(cap)),
      shine: new THREE.CircleGeometry(0.97, 48).translate(0, 0, 0.17),
      dialMat: new THREE.MeshStandardMaterial({ map: dial, emissive: '#ffffff', emissiveMap: dial, emissiveIntensity: 0.3, roughness: 0.45 }),
      handMat: glossy(hands[0]),
      secondMat: glossy(hands[1], { emissive: hands[1], emissiveIntensity: 0.25 }),
      glassMat: new THREE.MeshPhysicalMaterial({ color: '#ffffff', transparent: true, opacity: 0.1, roughness: 0, clearcoat: 1, depthWrite: false, envMapIntensity: 1.5 }),
      shineMat: new THREE.MeshBasicMaterial({ map: shine, transparent: true, depthWrite: false, toneMapped: false }),
    };
  });
  const hour = useRef<THREE.Mesh>(null), minute = useRef<THREE.Mesh>(null), second = useRef<THREE.Mesh>(null);
  useFrame(() => {
    const a = clockHands(new Date());
    if (hour.current) hour.current.rotation.z = -a.hour;
    if (minute.current) minute.current.rotation.z = -a.minute;
    if (second.current) second.current.rotation.z = -a.second;
  });
  return (
    <group>
      <mesh geometry={parts.dial} material={parts.dialMat} />
      <mesh ref={hour} geometry={parts.hour} material={parts.handMat} />
      <mesh ref={minute} geometry={parts.minute} material={parts.handMat} />
      <mesh ref={second} geometry={parts.second} material={parts.secondMat} />
      <mesh geometry={parts.hub} material={parts.secondMat} />
      <mesh geometry={parts.glass} material={parts.glassMat} renderOrder={2} />
      <mesh geometry={parts.shine} material={parts.shineMat} renderOrder={3} />
    </group>
  );
}

/** Turns a group (once) so that its +z faces `toward`. */
function useFacing(toward: V3) {
  const ref = useRef<THREE.Group>(null);
  const aimed = useRef(false);
  useFrame(() => {
    if (aimed.current || !ref.current) return;
    ref.current.lookAt(...toward);
    aimed.current = true;
  });
  return ref;
}

// ------------------------------------------------------------ the stages' clocks

/** Sanctuary: a glossy glass clock floating over the pool behind the dancers, bobbing gently. */
function FloatingClock({ position, toward, size }: { position: V3; toward: V3; size: number }) {
  const parts = useDisposable(() => ({
    bezel: new THREE.TorusGeometry(1.02, 0.075, 20, 80),
    back: new THREE.CylinderGeometry(1.06, 0.86, 0.26, 64).rotateX(Math.PI / 2).translate(0, 0, -0.14),
    chrome: new THREE.MeshPhysicalMaterial({ color: '#eaf8ff', metalness: 1, roughness: 0.12, clearcoat: 1 }),
    gel: glossy('#2f93ff', { emissive: '#0b4fae', emissiveIntensity: 0.35, roughness: 0.12 }),
  }));
  const float = useRef<THREE.Group>(null);
  const face = useFacing(toward);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (!float.current) return;
    float.current.position.y = Math.sin(t * 0.5) * 0.18;
    float.current.rotation.set(Math.sin(t * 0.37) * 0.05, Math.sin(t * 0.29 + 1) * 0.08, Math.sin(t * 0.41 + 2) * 0.03);
  });
  return (
    <group position={position}>
      <group ref={face}>
        <group ref={float} scale={size}>
          <mesh geometry={parts.back} material={parts.gel} />
          <mesh geometry={parts.bezel} material={parts.chrome} />
          <Dial face={{ dial: ['#ffffff', '#9fd8ff'], ink: '#0d3b7a', figures: true }} hands={['#0d2f66', '#ff8a1f']} />
        </group>
      </group>
    </group>
  );
}

/** Atrium: a white station clock hanging on two rods from the gallery round the column. */
function HangingClock({ position, toward, size, rodTop }: { position: V3; toward: V3; size: number; rodTop: number }) {
  const rod = rodTop - position[1];
  const parts = useDisposable(() => ({
    case: new THREE.CylinderGeometry(1.08, 1.08, 0.3, 64).rotateX(Math.PI / 2).translate(0, 0, -0.15),
    bezel: new THREE.TorusGeometry(1.06, 0.06, 16, 80),
    rod: new THREE.CylinderGeometry(0.02, 0.02, 1, 8).translate(0, 0.5, 0),
    white: glossy('#f4fbff'),
    chrome: new THREE.MeshPhysicalMaterial({ color: '#e6f4ff', metalness: 1, roughness: 0.15, clearcoat: 1 }),
  }));
  const face = useFacing(toward);
  return (
    <group position={position}>
      {[-0.55, 0.55].map((x) => <mesh key={x} geometry={parts.rod} material={parts.chrome} position={[x, size * 0.9, 0]} scale={[1, rod - size * 0.9, 1]} />)}
      <group ref={face} scale={size}>
        <mesh geometry={parts.case} material={parts.white} />
        <mesh geometry={parts.bezel} material={parts.chrome} />
        <Dial face={{ dial: ['#ffffff', '#eef7fb'], ink: '#14202e' }} hands={['#14202e', '#18b6e8']} />
      </group>
    </group>
  );
}

/** Beach: a ship's clock set in a glossy lifebuoy on a weathered post. */
function LifebuoyClock({ ground, height, toward, size }: { ground: V3; height: number; toward: V3; size: number }) {
  const stripes = useCanvasTexture(256, 16, (g, w, h) => {
    for (let i = 0; i < 8; i++) {
      g.fillStyle = i % 2 ? '#ffffff' : '#ff4136';
      g.fillRect((i / 8) * w, 0, w / 8 + 1, h);
    }
  });
  const parts = useDisposable(() => ({
    ring: new THREE.TorusGeometry(1.3, 0.34, 24, 96),
    case: new THREE.CylinderGeometry(1.04, 1.04, 0.24, 64).rotateX(Math.PI / 2).translate(0, 0, -0.12),
    post: new THREE.CylinderGeometry(0.1, 0.12, 1, 10).translate(0, 0.5, 0),
    buoy: glossy('#ffffff', { map: stripes, roughness: 0.25 }),
    brass: new THREE.MeshPhysicalMaterial({ color: '#f2c46b', metalness: 1, roughness: 0.2, clearcoat: 1 }),
    wood: new THREE.MeshStandardMaterial({ color: '#9a6a3c', roughness: 0.8 }),
  }));
  const face = useFacing([toward[0], ground[1] + height, toward[2]]);
  const top = height + size * 0.2;
  return (
    <group position={ground}>
      <mesh geometry={parts.post} material={parts.wood} scale={[1, top, 1]} position={[0, 0, -0.08]} castShadow />
      <group position={[0, height, 0]}>
        <group ref={face} scale={size}>
          <mesh geometry={parts.ring} material={parts.buoy} castShadow />
          <mesh geometry={parts.case} material={parts.brass} />
          <Dial face={{ dial: ['#ffffff', '#e6f2ff'], ink: '#0f2a52', figures: true }} hands={['#0f2a52', '#ff4136']} />
        </group>
      </group>
    </group>
  );
}

/** Falls: a clock flower, kin to the solar flowers: a white stem, glossy leaves, blue glass petals round the dial. */
function FlowerClock({ ground, height, toward, size }: { ground: V3; height: number; toward: V3; size: number }) {
  const parts = useDisposable(() => {
    const petal = new THREE.SphereGeometry(1, 20, 12).scale(0.36, 0.62, 0.08);
    return {
      stem: new THREE.CylinderGeometry(0.07, 0.11, 1, 12).translate(0, 0.5, 0),
      leaf: new THREE.SphereGeometry(1, 16, 10).scale(0.5, 0.14, 0.2).translate(0.5, 0, 0),
      petal,
      back: new THREE.CylinderGeometry(1.06, 0.7, 0.3, 48).rotateX(Math.PI / 2).translate(0, 0, -0.16),
      bezel: new THREE.TorusGeometry(1.02, 0.07, 16, 72),
      white: glossy('#ffffff'),
      leafMat: glossy('#7fdc2e', { roughness: 0.25 }),
      petalMat: new THREE.MeshPhysicalMaterial({
        color: '#7cc6ff', roughness: 0.1, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.03, iridescence: 0.5, iridescenceIOR: 1.4,
        emissive: '#0a3f8a', emissiveIntensity: 0.3, envMapIntensity: 1.4,
      }),
    };
  });
  const head = useFacing([toward[0], ground[1] + height, toward[2]]);
  const sway = useRef<THREE.Group>(null);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (sway.current) sway.current.rotation.set(Math.sin(t * 0.6) * 0.025, 0, Math.sin(t * 0.45 + 1) * 0.03);
  });
  return (
    <group position={ground}>
      <group ref={sway}>
        <mesh geometry={parts.stem} material={parts.white} scale={[1, height, 1]} castShadow />
        <mesh geometry={parts.leaf} material={parts.leafMat} position={[0.05, height * 0.32, 0]} rotation={[0, 0.4, 0.45]} />
        <mesh geometry={parts.leaf} material={parts.leafMat} position={[-0.05, height * 0.52, 0]} rotation={[0, 2.6, 0.5]} />
        <group position={[0, height, 0]}>
          <group ref={head} scale={size}>
            {Array.from({ length: 10 }, (_, i) => {
              const a = (i / 10) * TAU;
              return <mesh key={i} geometry={parts.petal} material={parts.petalMat} position={[Math.sin(a) * 1.45, Math.cos(a) * 1.45, -0.2]} rotation={[0, 0, -a]} />;
            })}
            <mesh geometry={parts.back} material={parts.white} />
            <mesh geometry={parts.bezel} material={parts.white} />
            <Dial face={{ dial: ['#ffffff', '#e9f9d8'], ink: '#1d5a2a' }} hands={['#1d4f8a', '#ff7a3d']} />
          </group>
        </group>
      </group>
    </group>
  );
}

/** Open reef: a big air bubble wobbling over the reef, the time glowing inside it, small bubbles streaming up. */
function BubbleClock({ position, toward, size }: { position: V3; toward: V3; size: number }) {
  const text = useClockTexture(512, 256, (g, now) => {
    const { time, period } = clockText(now);
    g.clearRect(0, 0, 512, 256);
    // A soft deep-blue lens behind the digits, so they read against bright water.
    const lens = g.createRadialGradient(256, 128, 0, 256, 128, 250);
    lens.addColorStop(0, 'rgba(6,40,110,0.62)');
    lens.addColorStop(0.7, 'rgba(6,40,110,0.4)');
    lens.addColorStop(1, 'rgba(6,40,110,0)');
    g.fillStyle = lens;
    g.fillRect(0, 0, 512, 256);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 ${period ? 132 : 150}px ${FONT}`;
    g.shadowColor = 'rgba(120,230,255,0.9)';
    g.shadowBlur = 18;
    g.fillStyle = '#ffffff';
    g.fillText(time, 256, period ? 116 : 132);
    if (period) {
      g.font = `600 44px ${FONT}`;
      g.fillText(period, 256, 210);
    }
  });
  const parts = useDisposable(() => ({
    bubble: new THREE.SphereGeometry(1, 64, 32),
    face: new THREE.PlaneGeometry(1.7, 0.85),
    // Additive, so the bubble is its reflections and rim, and clear in the middle.
    shell: new THREE.MeshPhysicalMaterial({
      color: '#000000', roughness: 0.02, metalness: 0, clearcoat: 1, iridescence: 1, iridescenceIOR: 1.3, iridescenceThicknessRange: [200, 600],
      envMapIntensity: 2.4, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }),
    rim: new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV;
        void main() { vec4 p = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-p.xyz); gl_Position = projectionMatrix * p; }`,
      fragmentShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV;
        void main() {
          float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.5);
          vec3 tint = mix(vec3(0.55, 0.95, 1.0), vec3(0.85, 0.7, 1.0), smoothstep(-0.4, 0.8, vN.y));
          gl_FragColor = vec4(tint * f * 0.85, 1.0);
        }`,
    }),
    text: new THREE.MeshBasicMaterial({ map: text, transparent: true, depthWrite: false, toneMapped: false, color: new THREE.Color(0.92, 0.92, 0.92) }),
    small: new THREE.SphereGeometry(1, 16, 10),
  }));
  const wobble = useRef<THREE.Group>(null), body = useRef<THREE.Mesh>(null), rim = useRef<THREE.Mesh>(null);
  const trail = useRef<(THREE.Mesh | null)[]>([]);
  const face = useFacing(toward);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (wobble.current) {
      wobble.current.position.set(Math.sin(t * 0.21) * 0.3, Math.sin(t * 0.43) * 0.25, 0);
    }
    // A bubble's breathing: squashing a little one way, then the other.
    const sx = 1 + Math.sin(t * 1.3) * 0.025, sy = 1 + Math.sin(t * 1.3 + Math.PI) * 0.025;
    body.current?.scale.set(sx, sy, sx);
    rim.current?.scale.set(sx * 1.004, sy * 1.004, sx * 1.004);
    trail.current.forEach((m, i) => {
      if (!m) return;
      const u = (t * 0.12 + i / TRAIL) % 1;
      m.position.set(Math.sin(t * 0.9 + i * 2.1) * 0.25 + (i % 3 - 1) * 0.35, -1.1 - 3 + u * 6.5, Math.cos(t * 0.7 + i) * 0.2);
      const s = 0.05 + (i % 4) * 0.025;
      m.scale.setScalar(u > 0.92 ? s * (1 - (u - 0.92) / 0.08) : s);
      m.visible = Math.abs(m.position.y) > 1.05;
    });
  });
  return (
    <group position={position}>
      <group ref={face} scale={size}>
        <group ref={wobble}>
          <mesh ref={body} geometry={parts.bubble} material={parts.shell} renderOrder={3} />
          <mesh ref={rim} geometry={parts.bubble} material={parts.rim} renderOrder={4} />
          <mesh geometry={parts.face} material={parts.text} renderOrder={2} />
          {Array.from({ length: TRAIL }, (_, i) => <mesh key={i} ref={(m) => { trail.current[i] = m; }} geometry={parts.small} material={parts.rim} renderOrder={4} />)}
        </group>
      </group>
    </group>
  );
}
const TRAIL = 9;

/** Club: the time in glowing LED digits across the middle of the curved video wall. */
function WallClock() {
  // The wall: a cylinder of radius 12.7 round the room's centre, its middle at the back (-z),
  // from y 3.3 to 9.6 (club/layout.ts SCREEN). The digits sit just in front of it.
  const R = 12.62, half = 16 * (Math.PI / 180), y0 = 4.6, y1 = 7.6;
  const W = 1024, H = Math.round(W * ((y1 - y0) / (R * half * 2)));
  const text = useClockTexture(W, H, (g, now) => {
    const { time, period } = clockText(now);
    g.clearRect(0, 0, W, H);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const label = period ? `${time} ${period}` : time;
    // As big as fits the band, with a margin either side for the glow.
    g.font = `800 100px ${FONT}`;
    const size = Math.round(Math.min(H * 0.8, (100 * W * 0.86) / g.measureText(label).width));
    g.font = `800 ${size}px ${FONT}`;
    // Glow first (cyan into magenta, like the wall's waves), then the bright core.
    const grad = g.createLinearGradient(W * 0.2, 0, W * 0.8, 0);
    grad.addColorStop(0, '#5ff6ff');
    grad.addColorStop(1, '#ff6ad8');
    g.shadowColor = '#4fd8ff';
    g.shadowBlur = H * 0.12;
    g.fillStyle = grad;
    g.fillText(label, W / 2, H * 0.53);
    g.shadowBlur = 0;
    g.globalAlpha = 0.85;
    g.fillStyle = '#ffffff';
    g.font = `800 ${size}px ${FONT}`;
    g.fillText(label, W / 2, H * 0.53);
    g.globalAlpha = 1;
    // LED rows: dark lines across the lettering, as a big screen's pixels show up close.
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = 'rgba(0,0,0,0.45)';
    for (let y = 0; y < H; y += 6) g.fillRect(0, y, W, 2);
    g.globalCompositeOperation = 'source-over';
  });
  const parts = useDisposable(() => {
    // Seen from inside: flip the texture's u so the digits read left to right.
    text.repeat.set(-1, 1);
    text.offset.set(1, 0);
    return {
      band: new THREE.CylinderGeometry(R, R, y1 - y0, 48, 1, true, Math.PI - half, half * 2).translate(0, (y0 + y1) / 2, 0),
      mat: new THREE.MeshBasicMaterial({ map: text, transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending, color: new THREE.Color(1.6, 1.6, 1.6), toneMapped: false }),
    };
  });
  return <mesh geometry={parts.band} material={parts.mat} renderOrder={5} />;
}

const CLOCKS: Record<StageId, () => ReactNode> = {
  club: () => <WallClock />,
  // Over the pool behind the dancers, left of centre, turned to the stage's camera.
  sanctuary: () => <FloatingClock position={[-7.4, 6.5, -7.5]} toward={[0, 4.5, 14]} size={1.3} />,
  // Under the gallery's front, left of the column, at the level of the first balconies.
  atrium: () => <HangingClock position={[-3.0, 7.0, -5.3]} toward={[0, 2.5, 9]} size={1.3} rodTop={9.45} />,
  openreef: () => <BubbleClock position={[4.4, 4.7, -5]} toward={[0, 3, 15]} size={1.7} />,
  // Right of the dancers and in line with them, by the surf rack, short of the right-hand torch.
  beach: () => <LifebuoyClock ground={[5.5, -0.57, 1.2]} height={2.1} toward={[0, 1.8, 16]} size={0.72} />,
  // Back at the meadow's edge, left of the dancers and short of the left solar flower.
  falls: () => <FlowerClock ground={[-6.2, -0.01, -4.6]} height={4.2} toward={[0, 4.3, 10.4]} size={0.85} />,
};

/** The stage's clock, shown while the Clock setting is In scene. */
export function SceneClock({ ctx }: { ctx: ScreensaverContext }) {
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    if (group.current) group.current.visible = ctx.clock() === 'scene';
  });
  const clock = CLOCKS[ctx.scenario as StageId];
  return clock ? <group ref={group} visible={false}>{clock()}</group> : null;
}

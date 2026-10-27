// The lounge on the right of the room: a deep teal velvet sofa heaped with cushions and a
// chunky knit blanket, a knitted pouf, a little walnut side table with two mugs of cocoa and
// candles, and a glossy globe lamp glowing behind it all.
import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { FLOOR, LAMP, POUF, SIDE_TABLE, SOFA } from './layout.ts';
import { lathe, merge, paint, place, rod, softBox } from './geometry.ts';
import type { Placement } from './geometry.ts';
import { patchRoom } from './room.ts';

const sofaAt: Placement = { position: [SOFA.x, FLOOR, SOFA.z], rotation: [0, SOFA.heading, 0] };
const lampGlobe = new THREE.Vector3(LAMP.x, FLOOR + LAMP.height, LAMP.z);

// The lamp's warm light on what's near it (the room has no light of its own there).
const lampGlow = /* glsl */ `
  vec3 toLamp = vec3(${lampGlobe.x.toFixed(2)}, ${lampGlobe.y.toFixed(2)}, ${lampGlobe.z.toFixed(2)}) - vRoomWorld;
  float lampD = length(toLamp);
  float lampLit = (0.25 + 0.75 * max(dot(normalize(vRoomNormal), toLamp / max(lampD, 1e-3)), 0.0)) / (1.0 + lampD * lampD * 0.5);
`;

/** The sofa and its cushions, in velvet with a soft sheen. */
function Sofa() {
  const material = useDisposable(() =>
    patchRoom(
      new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.78, sheen: 1, sheenRoughness: 0.45, sheenColor: new THREE.Color('#ffd9b0') }),
      {
        key: 'velvet',
        emissive: `${lampGlow}\ntotalEmissiveRadiance += diffuseColor.rgb * (BULB * lampLit * 1.4 + fireGlow(vRoomWorld, normalize(vRoomNormal)) * 0.8);`,
        ibl: 0.35,
      },
    ),
  );
  const geometry = useDisposable(() => {
    const teal = '#2f7480';
    const deep = '#235a64';
    const parts = [
      paint(softBox(4.3, 0.36, 1.55, 0.12).translate(0, 0.36, -0.02), deep),
      paint(softBox(4.3, 0.95, 0.32, 0.14).translate(0, 0.86, -0.64), deep),
      ...[-1, 1].flatMap((side) => [
        paint(softBox(2.04, 0.3, 1.2, 0.13).translate(side * 1.03, 0.68, 0.14), teal),
        paint(place(softBox(2.0, 0.78, 0.38, 0.17), { position: [side * 1.03, 1.15, -0.5], rotation: [-0.16, 0, 0] }), teal),
        paint(softBox(0.44, 0.64, 1.56, 0.18).translate(side * 2.12, 0.7, -0.02), deep),
      ]),
      // Throw cushions: cream, rust and mustard, plumped against the back.
      paint(place(softBox(0.74, 0.68, 0.24, 0.13), { position: [-1.55, 1.08, -0.24], rotation: [-0.3, 0.22, 0.12] }), '#efe2cc'),
      paint(place(softBox(0.66, 0.62, 0.22, 0.12), { position: [-0.95, 1.04, -0.2], rotation: [-0.26, -0.1, -0.1] }), '#c4562a'),
      paint(place(softBox(0.7, 0.66, 0.24, 0.13), { position: [1.32, 1.07, -0.24], rotation: [-0.28, -0.25, -0.08] }), '#dca23e'),
      paint(place(softBox(0.6, 0.56, 0.2, 0.11), { position: [0.72, 1.0, -0.12], rotation: [-0.22, 0.2, 0.14] }), '#efe2cc'),
    ];
    return merge(parts.map((g) => place(g, sofaAt)));
  });
  return <mesh geometry={geometry} material={material} />;
}

// Chunky knit: columns of V stitches with a cable every few columns, in stitch-sized uv units.
const knitColor = /* glsl */ `
  vec2 k = vUv * vec2(4.2, 5.2);
  float col = fract(k.x) - 0.5;
  float v = fract(k.y + abs(col) * 0.9);
  float stitch = smoothstep(0.0, 0.3, v) * (1.0 - smoothstep(0.62, 1.0, v)) * (1.0 - smoothstep(0.32, 0.5, abs(col)));
  float cable = step(2.5, mod(floor(k.x), 4.0));
  diffuseColor.rgb *= mix(0.55, 1.08, stitch) * mix(1.0, 0.85, cable * (1.0 - stitch));
`;

/** The knit throw over the sofa's near arm and the round pouf. */
function Knits() {
  const material = useDisposable(() => {
    const m = patchRoom(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, side: THREE.DoubleSide }), {
      key: 'knit',
      color: knitColor,
      emissive: `${lampGlow}\ntotalEmissiveRadiance += diffuseColor.rgb * (BULB * lampLit * 1.2 + fireGlow(vRoomWorld, normalize(vRoomNormal)) * 0.8);`,
      ibl: 0.3,
    });
    m.defines = { USE_UV: '' };
    return m;
  });
  const geometry = useDisposable(() => {
    // The throw: a sheet swept across the arm from the seat, falling in folds down its side.
    const profile = [
      [1.1, 0.85], [1.55, 0.87], [1.86, 0.99], [2.04, 1.07], [2.26, 1.07], [2.4, 0.95], [2.45, 0.66], [2.47, 0.32], [2.48, 0.06],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    const throwGeo = drape(new THREE.SplineCurve(profile), 1.35, 0.12);
    // The pouf: a fat round cushion.
    const pouf = lathe([[0.001, 0.0], [0.46, 0.0], [0.56, 0.06], [0.6, 0.22], [0.58, 0.38], [0.48, 0.47], [0.001, 0.5]], 40);
    scaleUv(pouf, 2 * Math.PI * 0.58, 1.6);
    return merge([
      paint(place(throwGeo, sofaAt), '#eadbc4', { uv: true }),
      paint(place(pouf, { position: [POUF.x, FLOOR, POUF.z] }), '#d8b48a', { uv: true }),
    ]);
  });
  return <mesh geometry={geometry} material={material} />;
}

/**
 * A sheet hanging over a profile (in x-y), swept `width` along z and rippled into soft folds
 * that deepen towards its hanging end. Its uv is in units along it.
 */
function drape(profile: THREE.Curve<THREE.Vector2>, width: number, folds: number): THREE.BufferGeometry {
  const along = 28;
  const across = 20;
  const length = profile.getLength();
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const p = new THREE.Vector2();
  const t = new THREE.Vector2();
  for (let i = 0; i <= along; i++) {
    const s = i / along;
    profile.getPointAt(s, p);
    profile.getTangentAt(s, t);
    for (let j = 0; j <= across; j++) {
      const u = j / across;
      const z = (u - 0.5) * width;
      const fold = Math.sin(u * Math.PI * 3.2 + s * 1.5) * folds * s * s;
      positions.push(p.x - t.y * fold, p.y + t.x * fold, z + Math.sin(s * 5 + u * 2) * 0.02);
      uvs.push(u * width, s * length);
    }
  }
  for (let i = 0; i < along; i++) {
    for (let j = 0; j < across; j++) {
      const a = i * (across + 1) + j;
      const b = a + across + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

function scaleUv(g: THREE.BufferGeometry, u: number, v: number): void {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v);
}

/** The side table, the mugs and candles on it, and the globe lamp: glossy, in one draw. */
function Things() {
  const material = useDisposable(() =>
    patchRoom(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08 }), {
      key: 'lounge-things',
      emissive: /* glsl */ `
        ${lampGlow}
        totalEmissiveRadiance += diffuseColor.rgb * (BULB * lampLit * 1.2 + fireGlow(vRoomWorld, normalize(vRoomNormal)) * 0.6);
        // The globe itself, lit from within.
        totalEmissiveRadiance += BULB * 2.2 * (1.0 - smoothstep(0.3, 0.36, lampD));
      `,
      ibl: 0.3,
    }),
  );
  const geometry = useDisposable(() => {
    const walnut = '#5a3218';
    const top = SIDE_TABLE.height;
    const table = [
      paint(lathe([[0.5, top - 0.06], [0.52, top - 0.03], [0.5, top], [0.001, top]], 40), walnut),
      paint(new THREE.CylinderGeometry(0.06, 0.07, top - 0.06, 12).translate(0, (top - 0.06) / 2, 0), walnut),
      paint(lathe([[0.32, 0], [0.3, 0.04], [0.001, 0.05]], 32), walnut),
    ];
    const mug = (x: number, z: number, color: string, turn: number) => [
      paint(lathe([[0.001, 0], [0.075, 0], [0.08, 0.17], [0.07, 0.17], [0.066, 0.02], [0.001, 0.02]], 20).translate(x, top, z), color),
      paint(new THREE.CylinderGeometry(0.068, 0.068, 0.01, 16).translate(x, top + 0.145, z), '#4a2412'),
      paint(place(new THREE.TorusGeometry(0.045, 0.014, 6, 12, Math.PI), { position: [x + Math.cos(turn) * 0.08, top + 0.085, z - Math.sin(turn) * 0.08], rotation: [0, turn, -Math.PI / 2] }), color),
    ];
    const candle = (x: number, z: number, height: number) => paint(new THREE.CylinderGeometry(0.075, 0.075, height, 16).translate(x, top + height / 2, z), '#f4e8d6');
    // A tripod of slim oak legs meeting under the globe.
    const lampLegs = [0, 1, 2].map((i) => {
      const a = (i / 3) * Math.PI * 2 + 0.3;
      return paint(rod([Math.cos(a) * 0.45, 0, Math.sin(a) * 0.45], [0, LAMP.height - 0.36, 0], 0.03, 8, 0.022), '#8a5a32');
    });
    const lamp = [
      ...lampLegs,
      paint(new THREE.SphereGeometry(0.33, 28, 18).translate(0, LAMP.height, 0), '#fff4e4'),
      paint(new THREE.CylinderGeometry(0.06, 0.08, 0.1, 12).translate(0, LAMP.height - 0.33, 0), '#c88a48'),
    ];
    return merge([
      ...[...table, ...mug(-0.16, 0.14, '#f2ede6', 0.5), ...mug(0.2, 0.08, '#c4562a', 2.4), candle(-0.12, -0.2, 0.3), candle(0.1, -0.28, 0.2)].map((g) =>
        place(g, { position: [SIDE_TABLE.x, FLOOR, SIDE_TABLE.z] }),
      ),
      ...lamp.map((g) => place(g, { position: [LAMP.x, FLOOR, LAMP.z] })),
    ]);
  });
  return <mesh geometry={geometry} material={material} />;
}

export function Lounge() {
  return (
    <>
      <Sofa />
      <Knits />
      <Things />
    </>
  );
}

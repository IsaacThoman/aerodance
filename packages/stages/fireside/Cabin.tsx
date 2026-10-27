// The glass A-frame itself: a polished plank floor with a big soft rug where the dancers stand,
// the steep roof's pine boarding and timber rafters overhead, and the front gable, all glass,
// with frost creeping in at its corners and the warm room faintly reflected in it.
import * as THREE from 'three';
import { useDisposable } from '../shared/hooks.ts';
import { shaderMaterial } from '../shared/glsl.ts';
import { noiseTexture, polar } from '../polar/world.ts';
import { BACK, COLLAR, FLOOR, GABLE, HALF, LAMP, MULLIONS, RAFTERS, RIDGE, RUG, roofX } from './layout.ts';
import { beam, lathe, merge, paint } from './geometry.ts';
import { patchRoom, room, roomPalette } from './room.ts';

// Planks running out towards the window, staggered, with a little tone and grain to each.
const floorColor = /* glsl */ `
  vec2 p = vRoomWorld.xz;
  float w = 0.52;
  float row = floor(p.x / w);
  float len = 4.0 + 2.0 * hash11(row * 3.1);
  float along = (p.y + hash11(row) * len) / len;
  float plank = floor(along);
  float tone = hash12(vec2(row, plank));
  float grain = noise4(vec2(p.x * 6.0, p.y * 0.35)).r * 0.5 + noise4(vec2(p.x * 22.0, p.y * 1.4) + 3.0).g * 0.25;
  vec3 wood = mix(vec3(0.17, 0.07, 0.027), vec3(0.24, 0.1, 0.04), tone) * (1.0 + grain * 0.3);
  // Seams fade out where they'd pack into a pixel, so the far floor stays calm.
  vec2 fw = fwidth(vec2(p.x / w, along));
  float seamX = 1.0 - smoothstep(0.0, 0.035 + fw.x, min(fract(p.x / w), 1.0 - fract(p.x / w)));
  float seamZ = 1.0 - smoothstep(0.0, 0.01 + fw.y, min(fract(along), 1.0 - fract(along)));
  float seam = max(seamX * (1.0 - smoothstep(0.15, 0.4, fw.x)), seamZ * (1.0 - smoothstep(0.04, 0.12, fw.y)));
  diffuseColor.rgb = wood * (1.0 - 0.55 * seam);
  floorSeam = seam;
`;

// The firelight pooling on the floor round the hearth.
const floorEmissive = /* glsl */ `
  totalEmissiveRadiance += diffuseColor.rgb * fireGlow(vRoomWorld, vec3(0.0, 1.0, 0.0)) * 0.5;
`;

// Pine boarding up the roof's slope, in courses running back from the gable.
const roofColor = /* glsl */ `
  vec3 p = vRoomWorld;
  float s = length(vec2(${HALF.toFixed(2)} - abs(p.x), p.y - ${FLOOR.toFixed(2)}));
  float w = 0.42;
  float row = floor(s / w);
  float len = 5.0 + 3.0 * hash11(row * 1.7);
  float along = (p.z + hash11(row + 9.0) * len) / len;
  float tone = hash12(vec2(row, floor(along)) + 4.0);
  float grain = noise4(vec2(s * 5.0, p.z * 0.3)).b;
  vec3 wood = mix(vec3(0.5, 0.31, 0.17), vec3(0.64, 0.42, 0.24), tone) * (1.0 + grain * 0.18);
  // Darker up towards the ridge, out of the lamps' reach.
  wood *= mix(1.0, 0.55, smoothstep(2.0, ${(RIDGE * 0.85).toFixed(2)}, p.y - ${FLOOR.toFixed(2)}));
  vec2 fw = fwidth(vec2(s / w, along));
  float seam = (1.0 - smoothstep(0.0, 0.05 + fw.x, min(fract(s / w), 1.0 - fract(s / w)))) * (1.0 - smoothstep(0.15, 0.4, fw.x));
  diffuseColor.rgb = wood * (1.0 - 0.5 * seam);
`;

const roofEmissive = /* glsl */ `
  totalEmissiveRadiance += diffuseColor.rgb * fireGlow(vRoomWorld, normalize(vRoomNormal)) * 1.2;
  // The fairy lights strung along the collar ties wash the boards above them.
  float strings = exp(-pow((vRoomWorld.y - ${(FLOOR + COLLAR).toFixed(2)}) * 0.55, 2.0));
  totalEmissiveRadiance += diffuseColor.rgb * BULB * strings * 0.08;
`;

const timberEmissive = /* glsl */ `
  totalEmissiveRadiance += diffuseColor.rgb * fireGlow(vRoomWorld, normalize(vRoomNormal)) * 1.1;
`;

/** The plank floor, receiving the dancers' shadows. */
function Floor() {
  const material = useDisposable(() =>
    patchRoom(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.4, metalness: 0 }), {
      key: 'floor',
      head: 'float floorSeam = 0.0;',
      color: floorColor,
      roughness: 'roughnessFactor = mix(roughnessFactor, 0.9, floorSeam);',
      emissive: floorEmissive,
      ibl: 0.14,
    }),
  );
  const geometry = useDisposable(() => new THREE.PlaneGeometry(HALF * 2, BACK - GABLE).rotateX(-Math.PI / 2).translate(0, FLOOR, (GABLE + BACK) / 2));
  return <mesh geometry={geometry} material={material} receiveShadow />;
}

// Cream wool: a deep border, soft concentric bands and a fluffy pile.
const rugColor = /* glsl */ `
  vec2 p = vRoomWorld.xz;
  float r = length(p) / ${RUG.radius.toFixed(2)};
  float fluff = noise4(p * 9.0).r * 0.5 + noise4(p * 3.0 + 5.0).g * 0.5;
  vec3 wool = mix(vec3(0.62, 0.52, 0.42), vec3(0.78, 0.68, 0.56), smoothstep(-0.6, 0.6, fluff));
  float band = smoothstep(0.84, 0.86, r) * (1.0 - smoothstep(0.92, 0.94, r)) + smoothstep(0.62, 0.635, r) * (1.0 - smoothstep(0.655, 0.67, r)) * 0.6;
  wool = mix(wool, vec3(0.55, 0.24, 0.12), band * 0.75);
  diffuseColor.rgb = wool;
`;

const rugEmissive = /* glsl */ `
  totalEmissiveRadiance += diffuseColor.rgb * fireGlow(vRoomWorld, vec3(0.0, 1.0, 0.0)) * 0.6;
`;

/** The round rug the dancers stand on: thick, with a rolled edge. */
function Rug() {
  const material = useDisposable(() =>
    patchRoom(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95 }), { key: 'rug', color: rugColor, emissive: rugEmissive, ibl: 0.3 }),
  );
  const geometry = useDisposable(() => {
    const R = RUG.radius;
    // From the rim inwards, so the faces look up.
    return lathe([[R, 0], [R, 0.015], [R - 0.04, 0.04], [R - 0.12, 0.05], [0.001, 0.05]], 96).translate(0, FLOOR, 0);
  });
  return <mesh geometry={geometry} material={material} receiveShadow />;
}

/** The roof planes' pine boarding, the inside of the A. */
function Roof() {
  const material = useDisposable(() =>
    patchRoom(new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.45 }), { key: 'roof', color: roofColor, emissive: roofEmissive, ibl: 0.2 }),
  );
  const geometry = useDisposable(() => {
    const top = FLOOR + RIDGE;
    const quad = (side: number) => {
      const g = new THREE.BufferGeometry();
      const a = [side * HALF, FLOOR, GABLE];
      const b = [0, top, GABLE];
      const c = [0, top, BACK];
      const d = [side * HALF, FLOOR, BACK];
      g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...d], 3));
      // Facing into the room.
      if (side > 0) g.setIndex([0, 2, 1, 3, 5, 4]);
      g.computeVertexNormals();
      return g;
    };
    return merge([paint(quad(-1), '#ffffff'), paint(quad(1), '#ffffff')]);
  });
  return <mesh geometry={geometry} material={material} />;
}

/** The rafters, collar ties and ridge beam, and the gable's frame, transom and mullions. */
function Timber() {
  const material = useDisposable(() =>
    patchRoom(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.35, clearcoat: 0.5, clearcoatRoughness: 0.2 }), {
      key: 'timber',
      emissive: timberEmissive,
      ibl: 0.25,
    }),
  );
  const geometry = useDisposable(() => {
    const parts: THREE.BufferGeometry[] = [];
    const wood = '#94603a';
    const frame = '#7a4a2a';
    const bronze = '#2a211c';
    const top = FLOOR + RIDGE;
    // Along the slope, a rafter sits on the boarding: its centre line set in by half its depth.
    const slope = new THREE.Vector2(HALF, RIDGE).normalize();
    const inward = (side: number, depth: number) => [-side * slope.y * depth * 0.5, -slope.x * depth * 0.5] as const;
    const rafter = (side: number, z: number, depth: number, width: number, color: string) => {
      const [dx, dy] = inward(side, depth);
      parts.push(paint(beam([side * HALF + dx, FLOOR + dy, z], [dx * 0.2, top + dy, z], depth, width, [0, 0, 1]), color));
    };
    for (const z of RAFTERS) {
      const gable = z === GABLE;
      const at = gable ? z + 0.3 : z;
      const depth = gable ? 0.75 : 0.55;
      const width = gable ? 0.6 : 0.36;
      for (const side of [-1, 1]) rafter(side, at, depth, width, gable ? frame : wood);
      const x = roofX(COLLAR) - depth * 0.6;
      parts.push(paint(beam([-x, FLOOR + COLLAR, at], [x, FLOOR + COLLAR, at], width, gable ? 0.55 : 0.45), gable ? frame : wood));
    }
    parts.push(paint(beam([0, top - 0.45, GABLE], [0, top - 0.45, BACK], 0.5, 0.6), wood));
    // The sill along the bottom of the glass, and slim bronze mullions up to the roof's edge.
    parts.push(paint(beam([-HALF, FLOOR + 0.12, GABLE + 0.2], [HALF, FLOOR + 0.12, GABLE + 0.2], 0.45, 0.24), frame));
    for (const x of MULLIONS) {
      const y = x === 0 ? FLOOR + RIDGE - 0.4 : FLOOR + RIDGE * (1 - Math.abs(x) / HALF);
      parts.push(paint(beam([x, FLOOR + 0.2, GABLE + 0.08], [x, y, GABLE + 0.08], 0.14, 0.16, [0, 0, 1]), bronze));
    }
    return merge(parts);
  });
  return <mesh geometry={geometry} material={material} />;
}

/**
 * The glass of the gable. Mostly clear: the warm room shows faintly in it (the fire and the
 * globe lamp, and a glow low down, stronger where we see the glass at an angle), a soft gloss
 * streak runs across it, and frost creeps in from the bottom corners and along the frame.
 */
function Glass() {
  const geometry = useDisposable(() => {
    const inset = 0.3;
    const top = RIDGE - inset * 1.6;
    const shape = new THREE.Shape([new THREE.Vector2(-roofX(inset) + inset, inset), new THREE.Vector2(roofX(inset) - inset, inset), new THREE.Vector2(0, top)]);
    return new THREE.ShapeGeometry(shape).translate(0, FLOOR, GABLE);
  });
  const material = useDisposable(() =>
    shaderMaterial({
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      uniforms: { uNoise: polar.uNoise, uFlicker: room.uFlicker, uFire: room.uFire, uLamp: { value: new THREE.Vector3(LAMP.x, FLOOR + LAMP.height, LAMP.z) } },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uFlicker;
        uniform vec3 uFire, uLamp;
        varying vec3 vWorld;
        ${noiseTexture}
        ${roomPalette}
        void main() {
          vec2 q = vec2(vWorld.x, vWorld.y - ${FLOOR.toFixed(2)});
          vec3 view = normalize(vWorld - cameraPosition);
          // Distance in from the frame: the sill below and the rafters either side.
          float side = (1.0 - abs(q.x) / ${HALF.toFixed(2)} - q.y / ${RIDGE.toFixed(2)}) * ${((HALF * RIDGE) / Math.hypot(HALF, RIDGE)).toFixed(3)};
          // Frost: feathery growth in from the frame (beyond the rafters, which hide the first unit
          // of it from inside), deepest in the bottom corners.
          float slant = max(side - 0.8, 0.0);
          float corner = exp(-q.y * 0.45) * exp(-slant * 0.6);
          float reach = 0.5 * exp(-slant * 1.3) + 0.3 * exp(-q.y * 2.0) + 0.85 * corner;
          float fern = noise4(q * 1.1).r * 0.55 + noise4(q * 3.1 + 4.0).g * 0.3 + noise4(q * 8.0 + 9.0).b * 0.15;
          float frost = smoothstep(0.48, 0.72, reach + fern * 0.5);
          float rime = frost * (0.45 + 0.55 * smoothstep(-0.2, 0.6, noise4(q * 6.0).a));
          // The warm room reflected: the fire, and the lit floor and rug low down.
          vec3 r = vec3(view.xy, -view.z);
          vec3 toFire = normalize(uFire - vWorld);
          float spot = max(dot(r, toFire), 0.0);
          float grazing = pow(1.0 - abs(view.z), 3.0);
          vec3 reflection = FIRELIGHT * (pow(spot, 900.0) * 0.5 + pow(spot, 60.0) * 0.06) * uFlicker;
          float lamp = max(dot(r, normalize(uLamp - vWorld)), 0.0);
          reflection += BULB * (pow(lamp, 1400.0) * 0.6 + pow(lamp, 90.0) * 0.05);
          reflection += FIRELIGHT * 0.022 * exp(-q.y * 0.35) * (1.0 + grazing * 3.0);
          // A broad gloss streak across the pane, the Aero touch.
          float streak = smoothstep(1.4, 0.0, abs(q.x * 0.55 + q.y - 9.5)) * 0.03 + smoothstep(0.25, 0.0, abs(q.x * 0.55 + q.y - 7.6)) * 0.03;
          // Lit cool by the night outside and warm by the room, brightest at its feathered edge.
          float feather = frost * (1.0 - frost) * 4.0;
          vec3 frostCol = mix(vec3(0.16, 0.26, 0.4), vec3(0.55, 0.36, 0.24) * uFlicker, exp(-q.y * 0.3) * 0.45) * (1.0 + feather * 0.6);
          vec3 col = reflection + vec3(0.6, 0.8, 1.0) * streak + frostCol * rime;
          gl_FragColor = vec4(col, rime * 0.62);
        }
      `,
    }),
  );
  return <mesh geometry={geometry} material={material} renderOrder={-600} />;
}

export function Cabin() {
  return (
    <>
      <Floor />
      <Rug />
      <Roof />
      <Timber />
      <Glass />
    </>
  );
}

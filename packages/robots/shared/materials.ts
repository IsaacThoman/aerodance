import * as THREE from 'three';
import { brushedTexture, carbonTexture, labelTexture, noiseTexture, stripeTexture } from './textures.ts';
import type { LabelOptions } from './textures.ts';

// The hall's material kit: physically based, lit by the hall's environment map and lights, so
// metal, paint and rubber read the same on every arm. Cached by their arguments and shared;
// an arm that needs something else makes its own (MeshPhysicalMaterial / MeshStandardMaterial,
// never unlit, which looks pasted on under this lighting).

const cache = new Map<string, THREE.Material>();

function cached<T extends THREE.Material>(key: string, make: () => T): T {
  let material = cache.get(key) as T | undefined;
  if (!material) cache.set(key, (material = make()));
  return material;
}

export interface PaintOptions {
  roughness?: number;
  /** A clear lacquer over the colour (0 none, 1 a full coat): factory robot paint is glossy. */
  clearcoat?: number;
  clearcoatRoughness?: number;
  /** Orange peel on castings: 0 smooth to 1 rough. */
  peel?: number;
  metalness?: number;
}

/** Painted or powder-coated metal: robot castings, frames, guards. */
export function paint(color: THREE.ColorRepresentation, { roughness = 0.38, clearcoat = 0.7, clearcoatRoughness = 0.18, peel = 0.4, metalness = 0 }: PaintOptions = {}): THREE.MeshPhysicalMaterial {
  return cached(`paint:${new THREE.Color(color).getHexString()}:${roughness}:${clearcoat}:${clearcoatRoughness}:${peel}:${metalness}`, () => {
    const bump = noiseTexture(1.5, 7);
    const material = new THREE.MeshPhysicalMaterial({
      color, roughness, metalness, clearcoat, clearcoatRoughness,
      bumpMap: peel > 0 ? bump : null,
      bumpScale: peel * 0.6,
    });
    if (peel > 0) {
      // The peel is fine: a few millimetres a blob on a 1 m UV tile.
      bump.repeat.set(4, 4);
    }
    return material;
  });
}

export type MetalKind = 'aluminium' | 'brushed' | 'steel' | 'chrome' | 'darkSteel' | 'blackAnodized' | 'blackOxide' | 'brass' | 'castIron' | 'titanium';

const METALS: Record<MetalKind, { color: string; roughness: number; brushed?: boolean; bump?: number }> = {
  aluminium: { color: '#c9ccd0', roughness: 0.34 },
  brushed: { color: '#d4d6d9', roughness: 0.3, brushed: true },
  steel: { color: '#b4b7bb', roughness: 0.28 },
  chrome: { color: '#f2f3f5', roughness: 0.06 },
  darkSteel: { color: '#55595f', roughness: 0.42 },
  blackAnodized: { color: '#232528', roughness: 0.38 },
  blackOxide: { color: '#1a1b1d', roughness: 0.5 },
  brass: { color: '#d3a74e', roughness: 0.3 },
  castIron: { color: '#5d6066', roughness: 0.62, bump: 0.8 },
  titanium: { color: '#9ea2a6', roughness: 0.36 },
};

/** Bare or anodized metal. `tint` recolours anodized aluminium (blue, red...). */
export function metal(kind: MetalKind = 'aluminium', { tint, roughness }: { tint?: THREE.ColorRepresentation; roughness?: number } = {}): THREE.MeshPhysicalMaterial {
  const spec = METALS[kind];
  return cached(`metal:${kind}:${tint ? new THREE.Color(tint).getHexString() : ''}:${roughness ?? ''}`, () => {
    const material = new THREE.MeshPhysicalMaterial({ color: tint ?? spec.color, metalness: 1, roughness: roughness ?? spec.roughness });
    if (spec.brushed) {
      material.roughnessMap = brushedTexture();
      material.roughness = Math.min(1, (roughness ?? spec.roughness) * 1.6);
      material.anisotropy = 0.6;
    }
    if (spec.bump) {
      material.bumpMap = noiseTexture(1, 11);
      material.bumpScale = spec.bump;
    }
    return material;
  });
}

/** Rubber and elastomers: bellows, bumpers, feet, the paddle's grips. */
export function rubber(color: THREE.ColorRepresentation = '#151617', roughness = 0.82): THREE.MeshStandardMaterial {
  return cached(`rubber:${new THREE.Color(color).getHexString()}:${roughness}`, () => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, bumpMap: noiseTexture(1, 5), bumpScale: 0.3 }));
}

/** Moulded plastic: covers, cable carriers, caps. */
export function plastic(color: THREE.ColorRepresentation, roughness = 0.45, clearcoat = 0): THREE.MeshPhysicalMaterial {
  return cached(`plastic:${new THREE.Color(color).getHexString()}:${roughness}:${clearcoat}`, () => new THREE.MeshPhysicalMaterial({ color, roughness, metalness: 0, clearcoat, clearcoatRoughness: 0.25 }));
}

/** A cable's or hose's sheath. */
export function sheath(color: THREE.ColorRepresentation = '#1c1d1f', roughness = 0.55): THREE.MeshPhysicalMaterial {
  return cached(`sheath:${new THREE.Color(color).getHexString()}:${roughness}`, () => new THREE.MeshPhysicalMaterial({ color, roughness, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.4 }));
}

/** Carbon fibre under a gloss coat (`repeat` weave tiles a UV unit). */
export function carbon(repeat = 6): THREE.MeshPhysicalMaterial {
  return cached(`carbon:${repeat}`, () => {
    const map = carbonTexture().clone();
    map.repeat.set(repeat, repeat);
    map.needsUpdate = true;
    return new THREE.MeshPhysicalMaterial({ map, roughness: 0.42, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.08 });
  });
}

/** Clear or tinted glazing and polycarbonate guards, drawn after the opaque things. */
export function glass(tint: THREE.ColorRepresentation = '#dfe9ee', opacity = 0.18, roughness = 0.05): THREE.MeshPhysicalMaterial {
  return cached(`glass:${new THREE.Color(tint).getHexString()}:${opacity}:${roughness}`, () => new THREE.MeshPhysicalMaterial({
    color: tint, roughness, metalness: 0, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
  }));
}

/**
 * Something lit from inside: status rings, LEDs, stack lights, screens. `intensity` over about 2
 * blooms. Still a standard material, so it shades a little where it's not glowing.
 */
export function glow(color: THREE.ColorRepresentation, intensity = 2.5, base: THREE.ColorRepresentation = '#111111'): THREE.MeshStandardMaterial {
  return cached(`glow:${new THREE.Color(color).getHexString()}:${intensity}:${new THREE.Color(base).getHexString()}`, () => new THREE.MeshStandardMaterial({
    color: base, emissive: color, emissiveIntensity: intensity, roughness: 0.3, metalness: 0,
  }));
}

/** Yellow-and-black (or any two colours) hazard stripes, `repeat` tiles a UV unit. */
export function stripes(repeat = 4, a?: string, b?: string): THREE.MeshPhysicalMaterial {
  return cached(`stripes:${repeat}:${a}:${b}`, () => {
    const map = stripeTexture(a, b).clone();
    map.repeat.set(repeat, repeat);
    map.needsUpdate = true;
    return new THREE.MeshPhysicalMaterial({ map, roughness: 0.45, clearcoat: 0.4 });
  });
}

/**
 * A printed label or plate: text on a colour, on a face whose UVs span 0..1 (a PlaneGeometry,
 * or one face of a box). See labelTexture for the options.
 */
export function label(lines: readonly string[], options: LabelOptions & { roughness?: number; metalness?: number } = {}): THREE.MeshPhysicalMaterial {
  const { roughness = 0.4, metalness = 0, ...rest } = options;
  return cached(`label:${JSON.stringify([lines, options])}`, () => new THREE.MeshPhysicalMaterial({
    map: labelTexture(lines, rest), roughness, metalness, clearcoat: 0.3,
    // Sits on the surface it's printed on without fighting it.
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
}

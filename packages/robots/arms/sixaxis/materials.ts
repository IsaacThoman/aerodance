import * as THREE from 'three';
import { stripes } from '../../shared/materials.ts';
import { noiseTexture } from '../../shared/textures.ts';
import { atlasTextures } from './decals.ts';

// The six-axis arm's materials. Nearly everything reads its finish from the swatch atlas
// (palette.ts, decals.ts) through the second UV set, so each link draws as one or two meshes:
// `painted` for the clear-coated castings, base and cabinet (orange peel in the first UV set),
// `palette` for bare metal, rubber, plastic, the lit lamps and every printed label, `cable` for
// the dress pack's corrugated conduit and hoses, and the shared hazard stripes.

export interface ArmMaterials {
  painted: THREE.MeshPhysicalMaterial;
  palette: THREE.MeshPhysicalMaterial;
  cable: THREE.MeshPhysicalMaterial;
  stripes: THREE.Material;
}

let made: ArmMaterials | null = null;

// A corrugated conduit's ribs, across V (the cable's length runs along V).
function corrugation(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 64;
  const g = c.getContext('2d');
  if (!g) throw Error('No 2D canvas');
  const grad = g.createLinearGradient(0, 0, 0, 64);
  for (let i = 0; i <= 4; i++) {
    grad.addColorStop(i / 4, '#000');
    if (i < 4) grad.addColorStop(i / 4 + 0.125, '#fff');
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 64);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** A physical material whose colour, clear coat, roughness, metalness and glow come from the atlas. */
function atlased(extra: THREE.MeshPhysicalMaterialParameters = {}): THREE.MeshPhysicalMaterial {
  const { color, orm, emissive } = atlasTextures();
  return new THREE.MeshPhysicalMaterial({
    map: color,
    roughnessMap: orm, roughness: 1,
    metalnessMap: orm, metalness: 1,
    clearcoatMap: orm, clearcoat: 1, clearcoatRoughness: 0.2,
    emissiveMap: emissive, emissive: '#ffffff', emissiveIntensity: 4,
    ...extra,
  });
}

export function armMaterials(): ArmMaterials {
  if (made) return made;
  const peel = noiseTexture(1.5, 7).clone();
  peel.channel = 0;
  peel.repeat.set(4, 4);
  peel.needsUpdate = true;
  const ribs = corrugation();
  ribs.channel = 0;
  ribs.repeat.set(1, 1);
  made = {
    painted: atlased({ bumpMap: peel, bumpScale: 0.22 }),
    // Labels are cut out of the atlas by their alpha (smoothly, with the multisampling).
    palette: atlased({ alphaTest: 0.5, alphaToCoverage: true }),
    cable: atlased({ bumpMap: ribs, bumpScale: 1.4 }),
    stripes: stripes(6),
  };
  return made;
}

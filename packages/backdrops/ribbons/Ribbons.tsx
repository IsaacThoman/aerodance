import * as THREE from 'three';
import { useDisposable } from '../../stages/shared/hooks.ts';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { STRAND_ATTRIBUTES, strandData } from './layout.ts';
import type { Bundle, StrandAttribute, StrandData } from './layout.ts';
import { glintFragment, glintVertex, ribbonFragment, ribbonVertex } from './shaders.ts';
import { world } from './palette.ts';

// Steps along each strand: plenty for smooth curves, as the shader bends every vertex.
const SEGMENTS = 320;

// Light for the ribbons' glossy sheen: from the upper right, in front.
const LIGHT_DIR = new THREE.Vector3(0.45, 0.55, 0.7).normalize();

function setStrandAttributes(geometry: THREE.InstancedBufferGeometry, data: StrandData) {
  for (const key of Object.keys(STRAND_ATTRIBUTES) as StrandAttribute[]) {
    geometry.setAttribute(key, new THREE.InstancedBufferAttribute(new Float32Array(data[key]), STRAND_ATTRIBUTES[key]));
  }
}

/** A strip from s 0..1 along x and v -1..1 across y, two vertices wide: the shader shapes it. */
function stripGeometry(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const positions = new Float32Array((SEGMENTS + 1) * 2 * 3);
  const index: number[] = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const s = i / SEGMENTS;
    positions.set([s, -1, 0, s, 1, 0], i * 6);
    if (i < SEGMENTS) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex(index);
  return g;
}

export interface RibbonsProps {
  bundles: readonly Bundle[];
  /** Strength of the soft fibres along the strands. */
  fibres?: number;
  specular?: number;
  /** Edge softness, as a fraction of the half-width (more is more out of focus). */
  softness?: number;
  /** Narrowest the strands get on screen, in pixels of half-width. */
  minPixels?: number;
  renderOrder?: number;
}

/** A layer of flowing, twisting ribbons of light: one instanced draw for all its strands. */
export function Ribbons({ bundles, fibres = 0.6, specular = 1.2, softness = 0.25, minPixels = 2, renderOrder = 0 }: RibbonsProps) {
  const geometry = useDisposable(() => {
    const g = stripGeometry();
    const data = strandData(bundles);
    setStrandAttributes(g, data);
    g.instanceCount = data.aP0.length / 4;
    return g;
  }, [bundles]);

  const material = useDisposable(
    () =>
      shaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: false,
        premultipliedAlpha: true,
        side: THREE.DoubleSide,
        uniforms: {
          uTime: world.uTime,
          uMinPixels: { value: minPixels },
          uLightDir: { value: LIGHT_DIR },
          uFibres: { value: fibres },
          uSpecular: { value: specular },
          uSoftness: { value: softness },
        },
        vertexShader: ribbonVertex,
        fragmentShader: ribbonFragment,
      }),
    [fibres, specular, softness, minPixels],
  );

  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={renderOrder} />;
}

export interface GlintsProps {
  data: { strands: StrandData; glint: number[]; color: number[] };
  intensity?: number;
  renderOrder?: number;
}

/** Star glints travelling along the strands' edges, bright enough to bloom. */
export function Glints({ data, intensity = 3, renderOrder = 0 }: GlintsProps) {
  const geometry = useDisposable(() => {
    const plane = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = plane.index;
    g.setAttribute('position', plane.attributes.position);
    setStrandAttributes(g, data.strands);
    g.setAttribute('aGlint', new THREE.InstancedBufferAttribute(new Float32Array(data.glint), 4));
    g.setAttribute('aGlintColor', new THREE.InstancedBufferAttribute(new Float32Array(data.color), 3));
    g.instanceCount = data.glint.length / 4;
    return g;
  }, [data]);

  const material = useDisposable(
    () =>
      shaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: false,
        premultipliedAlpha: true,
        uniforms: { uTime: world.uTime, uIntensity: { value: intensity } },
        vertexShader: glintVertex,
        fragmentShader: glintFragment,
      }),
    [intensity],
  );

  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={renderOrder} />;
}

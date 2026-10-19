import * as THREE from 'three';
import { bubbleFS, bubbleVS } from '../aero/bubbles.ts';

/**
 * Effects for the menu stage's dancers (menu/MenuDancers.tsx): the soap bubble a joining
 * dancer arrives in, the droplets a bubble or a leaving dancer bursts into, and the "!" the
 * others show when someone pops.
 */

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const easeOutCubic = (x: number) => 1 - (1 - clamp01(x)) ** 3;
export const easeOutBack = (x: number) => {
  const t = clamp01(x) - 1;
  return 1 + 2.7 * t * t * t + 1.7 * t * t;
};

// A light from above left, in view space (the stage camera never turns).
const LIGHT = new THREE.Vector3(-0.4, 0.8, 0.5).normalize();

/** The background bubbles' iridescent shader, with a fade for popping. */
export function bubbleMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uLight: { value: LIGHT }, uTime: { value: 0 }, uFade: { value: 1 } },
    transparent: true,
    depthWrite: false,
    vertexShader: bubbleVS,
    fragmentShader: `uniform float uFade;\n${bubbleFS.replace('clamp(a,0.0,1.0))', 'clamp(a,0.0,1.0)*uFade)')}`,
  });
}

/** A soap bubble around a dancer: grows in, wobbles, then pops. */
export class SpawnBubble {
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  constructor(geometry: THREE.SphereGeometry) {
    this.mesh = new THREE.Mesh(geometry, bubbleMaterial());
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
  }
  /** `size` is the radius; `squash` > 1 stretches it upwards. */
  set(x: number, y: number, size: number, squash: number, fade: number) {
    const m = this.mesh;
    m.visible = size > 0.001 && fade > 0.001;
    m.position.set(x, y, 0);
    m.scale.set(size / Math.sqrt(squash), size * squash, size / Math.sqrt(squash));
    m.material.uniforms.uFade.value = fade;
  }
  hide() { this.mesh.visible = false; }
  dispose() { this.mesh.material.dispose(); }
}

const DROP_LIFE = 0.7;
const GRAVITY = 9;

/** A spray of small spheres that fly out, fall and shrink away. */
export class Burst {
  readonly group = new THREE.Group();
  private readonly drops: { m: THREE.Mesh; v: THREE.Vector3; r: number }[] = [];
  private t = Infinity;
  private readonly size: number;
  constructor(geometry: THREE.SphereGeometry, material: THREE.Material, count: number, size: number) {
    this.size = size;
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(geometry, material);
      m.renderOrder = 3;
      m.visible = false;
      this.group.add(m);
      this.drops.push({ m, v: new THREE.Vector3(), r: 1 });
    }
  }
  /** Sprays from (x, y) inside a sphere of `radius`, flying out at about `speed`. */
  fire(x: number, y: number, radius: number, speed: number) {
    this.t = 0;
    for (const d of this.drops) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 - 0.2, Math.random() - 0.5).normalize();
      d.m.position.set(x, y, 0).addScaledVector(dir, radius * (0.6 + Math.random() * 0.4));
      d.v.copy(dir).multiplyScalar(speed * (0.6 + Math.random() * 0.7));
      d.v.y += speed * 0.5;
      d.r = this.size * (0.6 + Math.random() * 0.8);
      d.m.visible = true;
    }
  }
  update(dt: number) {
    if (this.t > DROP_LIFE) return;
    this.t += dt;
    const left = 1 - this.t / DROP_LIFE;
    for (const d of this.drops) {
      d.v.y -= GRAVITY * dt;
      d.m.position.addScaledVector(d.v, dt);
      d.m.scale.setScalar(d.r * Math.max(0, left));
      d.m.visible = left > 0;
    }
  }
}

/** A white "!" with a navy outline, as a sprite. */
export function exclaimSprite() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const g = canvas.getContext('2d');
  if (g) {
    g.font = '900 112px "Inter", "Helvetica Neue", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = 14;
    g.strokeStyle = '#0c2f52';
    g.strokeText('!', 64, 68);
    g.fillStyle = '#ffffff';
    g.fillText('!', 64, 68);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.renderOrder = 4;
  sprite.visible = false;
  return sprite;
}

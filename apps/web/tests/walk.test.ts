import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { SceneCollider, isSolid } from '../src/walk/collider.ts';
import { NO_INPUT, bodyFor, createWalker, look, stepWalker, toggleNoclip } from '../src/walk/walker.ts';
import type { Walker, WalkerInput } from '../src/walk/walker.ts';
import { WALK_SCENES, stepScene, walkSceneFor } from '../src/walk/scenes.ts';
import { BACKDROP_METAS } from '../../../packages/backdrops/catalog.ts';
import { STAGE_METAS } from '../../../packages/stages/catalog.ts';

const DT = 1 / 60;
const body = bodyFor(1);

// A box w×h×d whose bottom sits at y, centred on x, z.
function box(scene: THREE.Scene, w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material = new THREE.MeshBasicMaterial()) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y + h / 2, z);
  scene.add(mesh);
  return mesh;
}

// A floor 40 m across with its top at y = 0.
function room() {
  const scene = new THREE.Scene();
  box(scene, 40, 1, 40, 0, -1, 0);
  return scene;
}

function run(walker: Walker, scene: THREE.Scene, seconds: number, input: Partial<WalkerInput> = {}) {
  const collider = new SceneCollider(scene);
  for (let t = 0; t < seconds; t += DT) {
    collider.focus(walker.position, 5);
    stepWalker(walker, { ...NO_INPUT, ...input }, DT, collider, body);
  }
}

const near = (actual: number, expected: number, within = 0.02) => assert.ok(Math.abs(actual - expected) <= within, `${actual} is not within ${within} of ${expected}`);

test('a walker dropped over the floor lands on it', () => {
  const walker = createWalker();
  walker.position.set(0, 3, 0);
  run(walker, room(), 2);
  assert.ok(walker.grounded);
  near(walker.position.y, 0, 1e-3);
});

test('walking forward goes the way they look, at walking speed', () => {
  const walker = createWalker();
  run(walker, room(), 0.5);
  run(walker, room(), 2, { forward: 1 });
  assert.ok(walker.position.z < -7, `went to z ${walker.position.z}`);
  near(walker.position.x, 0, 1e-6);
  near(walker.velocity.length(), body.walk, 0.05);
  // Turned a quarter left (yaw grows anticlockwise from above), forward is -x.
  look(walker, Math.PI / 2, 0);
  const x = walker.position.x;
  run(walker, room(), 1, { forward: 1 });
  assert.ok(walker.position.x < x - 3);
});

test('a wall stops them a body radius short, and they slide along it at an angle', () => {
  const scene = room();
  box(scene, 40, 4, 1, 0, 0, -5.5);
  const walker = createWalker();
  run(walker, scene, 3, { forward: 1 });
  near(walker.position.z, -5 + body.radius, 0.03);
  look(walker, -Math.PI / 4, 0);
  const x = walker.position.x;
  run(walker, scene, 1, { forward: 1 });
  assert.ok(walker.position.x > x + 1, 'slid along the wall');
  assert.ok(walker.position.z > -5, 'stayed out of the wall');
});

test('they step up a kerb but not up a wall waist high', () => {
  const scene = room();
  box(scene, 4, 0.3, 4, 0, 0, -4);
  box(scene, 4, 1, 4, 0, 0, -12);
  const walker = createWalker();
  run(walker, scene, 1.4, { forward: 1 });
  near(walker.position.y, 0.3, 1e-3);
  run(walker, scene, 3, { forward: 1 });
  assert.ok(walker.position.z > -10, `went through to z ${walker.position.z}`);
  assert.ok(walker.position.y < 0.01);
});

test('a jump goes about a metre up and comes back down', () => {
  const walker = createWalker();
  const scene = room();
  run(walker, scene, 0.5);
  const collider = new SceneCollider(scene);
  let top = 0;
  stepWalker(walker, { ...NO_INPUT, jump: true }, DT, collider, body);
  for (let t = 0; t < 2; t += DT) {
    collider.focus(walker.position, 5);
    stepWalker(walker, NO_INPUT, DT, collider, body);
    top = Math.max(top, walker.position.y);
  }
  near(top, 1.1, 0.1);
  assert.ok(walker.grounded);
});

test('they fall off a ledge, and keep falling with nothing below', () => {
  const walker = createWalker();
  const scene = room();
  run(walker, scene, 0.5);
  run(walker, scene, 6, { forward: 1 });
  assert.ok(!walker.grounded);
  assert.ok(walker.position.y < -20);
});

test('noclip flies where they look, through walls', () => {
  const scene = room();
  box(scene, 40, 4, 1, 0, 0, -5.5);
  const walker = createWalker();
  run(walker, scene, 0.5);
  assert.equal(toggleNoclip(walker), 'noclip');
  look(walker, 0, 0.3);
  run(walker, scene, 2, { forward: 1 });
  assert.ok(walker.position.z < -8, 'through the wall');
  assert.ok(walker.position.y > 2, 'climbing as it looks up');
  run(walker, scene, 0.2, { up: -1 });
  assert.ok(walker.position.y > 0.5, `still above the floor at y ${walker.position.y}`);
  assert.equal(toggleNoclip(walker), 'walk');
  run(walker, scene, 3);
  assert.ok(walker.grounded);
});

test('only what looks solid collides', () => {
  const solid = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  assert.ok(isSolid(solid));
  assert.ok(!isSolid(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.2 }))));
  assert.ok(!isSolid(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending }))));
  assert.ok(!isSolid(new THREE.Mesh(new THREE.SphereGeometry(), new THREE.MeshBasicMaterial({ side: THREE.BackSide }))));
  assert.ok(!isSolid(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }))));
  assert.ok(isSolid(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ depthWrite: false }))), 'a backdrop’s ground');
  const placed = new THREE.InstancedBufferGeometry();
  placed.setAttribute('position', new THREE.BoxGeometry().getAttribute('position'));
  assert.ok(!isSolid(new THREE.Mesh(placed, new THREE.MeshBasicMaterial())), 'copies a shader places');
  assert.ok(!isSolid(new THREE.Points(new THREE.BoxGeometry(), new THREE.PointsMaterial())));
  assert.ok(!isSolid(new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 5000)));
});

test('each copy of an instanced mesh collides where it is', () => {
  const scene = room();
  const pillars = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 4, 1), new THREE.MeshBasicMaterial(), 2);
  pillars.setMatrixAt(0, new THREE.Matrix4().makeTranslation(10, 2, 0));
  pillars.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0, 2, -6));
  scene.add(pillars);
  const walker = createWalker();
  run(walker, scene, 3, { forward: 1 });
  near(walker.position.z, -5.5 + body.radius, 0.05);
});

test('hidden meshes stop colliding once refreshed', () => {
  const scene = room();
  const wall = box(scene, 40, 4, 1, 0, 0, -5.5);
  wall.visible = false;
  const walker = createWalker();
  run(walker, scene, 3, { forward: 1 });
  assert.ok(walker.position.z < -8);
});

test('walk mode opens every scene, Skyline by default, and steps round them', () => {
  assert.deepEqual(WALK_SCENES.map((s) => s.id), ['skyline', ...BACKDROP_METAS.map((m) => m.id), ...STAGE_METAS.map((m) => m.id)]);
  assert.equal(new Set(WALK_SCENES.map((s) => s.key)).size, WALK_SCENES.length);
  assert.equal(new Set(WALK_SCENES.map((s) => s.name)).size, WALK_SCENES.length);
  assert.equal(walkSceneFor('koi').id, 'koi');
  assert.equal(walkSceneFor('beach').kind, 'stage');
  assert.equal(walkSceneFor(null).id, 'skyline');
  assert.equal(walkSceneFor('lava').id, 'skyline');
  assert.equal(stepScene('skyline', -1).key, WALK_SCENES.at(-1)?.key);
  assert.equal(stepScene(WALK_SCENES.at(-1)?.key ?? 'skyline', 1).id, 'skyline');
});

test('a stage named like a backdrop gets a key of its own', () => {
  const backdrop = walkSceneFor('atrium');
  const stage = walkSceneFor('atrium-stage');
  assert.deepEqual([backdrop.kind, backdrop.id], ['backdrop', 'atrium']);
  assert.deepEqual([stage.kind, stage.id], ['stage', 'atrium']);
  assert.equal(stepScene('atrium-stage', 0).key, 'atrium-stage');
  assert.equal(walkSceneFor('club').key, 'club');
});

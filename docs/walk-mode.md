# Walk mode

`/?walk` opens the game's scenes for walking round in first person, like an FPS, instead of
playing: Skyline (the Aero world), the ten menu backdrops and the seven dance stages, each drawn
as the game draws it (the same 640×480 buffer, post-processing and aspect). `/?walk=<id>` opens
one (`koi`, `club`, `beach`…); a stage that shares its id with a backdrop goes by `<id>-stage`
(`atrium-stage`, beside the `atrium` backdrop). The URL follows the scene as it changes, so a
reload comes back to it. It's only loaded for `?walk`, and nothing in the game links to it.

You start where the scene's own camera stands, looking the same way, and drop to whatever is
under you, or a little ahead of you where a scene only has ground in front of its camera. Where
there's nothing to stand on (Bubbles, Ribbons, Dewdrops, Jellyfish) or only a planet (Orbit), you
start flying. On the stages the dancers loop the menu's captured dance.

| Key | Does |
| --- | --- |
| WASD or the arrows, mouse | Move, look (click the picture first: the pointer locks to it) |
| Space, Shift, C | Jump, run, crouch |
| Z | Noclip: fly through everything where you look; Space up, C down, the wheel for speed (Shift for three times as fast) |
| R | Back to where you started |
| `[` `]` | The previous or next scene |
| H | Hide the overlay |
| Esc | The menu: every scene, and the controls |

Where the browser won't lock the pointer, dragging looks round instead. Falling for four
seconds with nothing below takes you back to the start.

## How it works

- `apps/web/src/walk/WalkApp.tsx` is the page (`main.tsx` loads it lazily for `?walk`). It
  hosts one scene with the game's own components: `AeroWorld`, `BackdropView` or `StageView`
  (with `demo`, so its dancers dance), and remounts on a change of scene.
- Every scene camera hands itself over each frame: `StageCamera` and `BackdropCamera` call
  `cameraPilot.fly` (`packages/stages/shared/hooks.ts`) after their own rig has moved it, and
  the Aero world's drone does through `createAeroWorld`'s `steer`. Walk mode sets `fly`; the game
  never does, so its cameras are unchanged. Anything that follows the camera (the sky, the
  Aero world's culling and reflection) follows the walker too.
- `apps/web/src/walk/walker.ts` is the movement, independent of three's scene: walking with
  gravity, sliding along walls, stepping up ledges under 45 cm and jumping, and noclip flight.
  It sees the world only through ray casts. Distances are in metres times the scene's `scale`
  (`walk/scenes.ts`): a stage is 1.5 units to the metre (its dancers are 2.6 units tall), except
  the atrium, built in metres like its backdrop; Koi Pond 2 and Aurora 2.5.
- `apps/web/src/walk/collider.ts` casts those rays against the scene's solid meshes, through a
  [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) tree per geometry, built when the
  scene is ready (under 0.1 s for the biggest) and kept beside the geometry rather than in it.
  Solid means a mesh that looks it: not additive, not a sky dome seen from inside, and not
  see-through (mostly transparent, or transparent and drawn without depth). Dancers, particles,
  big instanced foliage, and copies placed by a shader don't collide. Shaders that move
  vertices (waves, swaying grass, the cloud sea's puffs) aren't seen, so you walk on the
  surface the geometry has before they move it. A step costs under a millisecond on an M5 Pro.
- `apps/web/src/walk/WalkHud.tsx` draws the overlay with the game's canvas UI: the scene and
  mode on a glass chip, the aiming dot, short notices, and the menu (`walk/layout.ts`).

## Testing it

`apps/web/tests/walk.test.ts` checks the walker against simple scenes (landing, walls,
ledges, jumps, falling, noclip, instanced copies, what counts as solid) and the scene list.

With [`scripts/play.ts`](interactive-testing.md): `start --url '/?walk=club'` (or `goto`) waits
until the scene is ready; `click walk.RESUME` walks (`walk.sceneRect.<n>` picks
`WALK_SCENES[n]`); `key w:1500` holds W for 1.5 s (`Shift+w:800` runs); `drag` looks round, as
headless Chromium gets no pointer lock. The canvas reports `walkScene`, `walkReady`,
`walkFailed`, `walkPaused`, `walkMode` (`walk` or `noclip`), `walkGrounded`, `walkPosition`
(x,y,z of the feet), `walkLook` (yaw,pitch in degrees) and `walkSolids` (meshes it collides with).

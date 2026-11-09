# Arenas

Places to play table tennis in, in the game's Frutiger Aero look. Each is built round a
regulation table at the origin, like the stages and backdrops: generated geometry, shaders and
canvas textures, no asset files. Table Tennis (`apps/web/src/minigames/table-tennis`) plays in
them; its **Scene** setting picks one, or the plain room it was built in (Debug).

| Folder | Name | What it is |
| --- | --- | --- |
| `biodome` | Biodome | A table-tennis deck high in a rainforest canopy, under a geodesic glass dome, by a waterfall |

## Layout

- `biodome/BiodomeArena.tsx`: the whole place, with its lights, fog and reflections
  (`StageEnvironment`). The host brings the camera and the post-processing (`BIODOME_POST`), and
  a camera far plane of `BIODOME_FAR`. Its `children` go on the table.
- `shared/Table.tsx`: `Table`, a regulation table with its net and posts (2.74 × 1.525 m, the
  surface 76 cm up), styled per arena: surface, lines, edge band, legs, an optional light strip,
  the net's colours. `TABLE` has the dimensions.
- `shared/Gear.tsx`: `Paddle`, `Ball` and `TableSet` (two paddles left on the table and a ball).
- `shared/frame.ts`: `useArenaFrame`, the arenas' clock. It's their own, so they keep moving
  while a game has the screen (the menu backdrops' clock stops then).

## Conventions

- Built in metres, round the table at the origin: its long axis along z, the floor at y = 0.
- The [backdrops' guidance](../backdrops/README.md#making-one) holds here too: bold shapes over
  fine detail at 640×480, bloom thresholds above lit surfaces, NaN-safe shaders, loops that never
  visibly reset, no allocation per frame.
- The ball's physics don't know an arena's shapes: Table Tennis bounces it off the table, the net
  and the floor, and off walls 3 m to either side of the table (its debug room's).

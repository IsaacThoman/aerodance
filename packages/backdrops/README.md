# Menu backdrops

Ten procedural Frutiger Aero scenes that can stand behind the menus in place of the Aero world's drone flight (`apps/web/src/aero`). Settings → Graphics → Background picks one; `?background=<id>` picks one for a visit. They aren't dance stages: nobody dances in them, and they only have to look good behind the title, the menus and the menu dancers. Like the stages, everything is generated (geometry, shaders, canvas textures).

| Id | Name | Highlights |
| --- | --- | --- |
| `aurora` | Aurora | Night at a mirror lake: folding aurora curtains, twinkling stars and shooting stars, snowy peaks, pines, a glass A-frame cabin with warm windows, fireflies, rippled reflections |
| `bubbles` | Bubbles | Aqua depths: iridescent soap-film bubbles that wobble as they rise, god rays, caustics on the surface overhead, bokeh at three depths |
| `ribbons` | Ribbons | The Vista "Aurora" look: twisting ribbons of lime, cyan and aqua light that flare where they turn edge-on, travelling glints, a soft sun flare |
| `cloudsea` | Cloud Sea | Sunrise above rolling clouds: pastel sky, god rays and lens flare, a glossy airship, glass garden pods, circling gulls |
| `hills` | Bliss Hills | Smooth emerald hills with wind waves and cloud shadows, a sparkling river, wind turbines on the ridge, glass greenhouse domes, cumulus |
| `koi` | Koi Pond | A clear jade pond from above: seven koi swimming lazy loops, caustics on the pebbles, lily pads and lotus flowers, ripple rings, cherry petals, sun glitter |
| `atrium` | Atrium | A sunlit eco-tech atrium: ribbed glass dome, curved white balconies hung with vines, an aquarium column with schools of small fish darting round, climbing and sinking, a reflecting pool with koi, a maglev outside. Its room is the `atrium` dance stage's |
| `dew` | Dewdrops | Leaves up close: drops that magnify the veins, a slow drip cycle, a ladybug, sunlit bokeh, a sunshower |
| `orbit` | Orbit | A glossy Earth at sunrise: clouds, ocean glint, city lights, an atmosphere rim, a space station with a turning glass ring, satellites, the Moon |
| `jellyfish` | Jellyfish | Open water: glowing glass-like jellies that pulse and drift, trailing tentacles and frilly arms, light rays, marine snow, plankton sparkles |

## Layout

- `catalog.ts`: the backdrops as plain data (each folder's `meta.ts`: settings name, subtitle, post settings), with no rendering code.
- `index.ts`: pairs each meta with its lazily loaded `<Name>Backdrop.tsx`, so only the one showing is fetched.
- `shared/frame.ts`: the backdrop clock and `useBackdropFrame`, which stops while a dance stage has the screen and runs at half speed with prefers-reduced-motion; and `backdropPost`, the live post settings of the backdrop showing.
- `shared/BackdropCamera.tsx`: the camera, with slow drift and a lean towards the pointer. Use it rather than a camera of your own: [walk mode](../../docs/walk-mode.md) takes it over through `cameraPilot`.
- Backdrops also use the stages' shared modules: `Sky.tsx`, `Environment.tsx`, `glsl.ts`, `random.ts` and `useDisposable` in `hooks.ts`. Atrium's room is the `atrium` stage's (`packages/stages/atrium`), seen from the menu's camera.

The game hosts them in `apps/web/src/backdrop/BackdropView.tsx`: a createPortal scene drawn through the stages' `RenderPipeline` (stage → bloom → grade → ACES) into the 640×480 buffer.

## Making one

- The menu draws the title and its buttons over the left half and the menu dancers, glass figures on a glass puck, over the lower right. Keep the left calm enough for white text, and keep the area behind the dancers mid-toned so the glass reads. Check 16:9 and 4:3 (4:3 shows more above and below).
- The buffer is 640×480 without MSAA, shown stretched to the screen: prefer bold shapes, smooth gradients and soft glows to fine detail, which shimmers.
- Move everything by the backdrop clock (`useBackdropFrame`'s `time`), never R3F's clock or `Date.now()`, in loops that never visibly reset.
- They run behind the menus on integrated GPUs, phones and the Apple TV: aim for under ~80 draw calls and ~300k triangles, instance repeated things, animate in shaders, and don't allocate per frame. Work that doesn't change, like a pebble floor or a noise field, can be drawn into a texture once at load. In development `window.__aeroStats` reports the last frame's counts.
- Bloom adds a pixel's whole brightness once it passes the threshold, so a broad bright sky above it hazes the whole picture: keep large areas under it and let only glints through. Bloom is also the costliest pass (about 1.3 ms of an M5 Pro's frame); `bloomStrength: 0` leaves it out.
- A NaN from a shader (`pow` of a negative, `atan(0, 0)`) spreads through the bloom until the frame is black: guard them.

At the last measurement (Apple M5 Pro, menu and dancers on), the whole frame took 47–56 draw calls, 0.11–0.26M triangles and 1.9–3.0 ms of GPU time with each backdrop, against 252 calls, 1.08M triangles and 2.8 ms with the Aero world.

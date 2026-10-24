# Menu backdrops

Ten procedural Frutiger Aero scenes that can stand behind the menus in place of the Aero world's drone flight (`apps/web/src/aero`). Settings → Graphics → Background picks one; `?background=<id>` picks one for a visit. They aren't dance stages: nobody dances in them, and they only have to look good behind the title, the menus and the menu dancers. Like the stages, everything is generated (geometry, shaders, canvas textures).

| Id | Name | Shows |
| --- | --- | --- |
| `aurora` | Aurora | Northern lights over a mirror lake |
| `bubbles` | Bubbles | Glossy bubbles rising through aqua light |
| `ribbons` | Ribbons | Flowing ribbons of light |
| `cloudsea` | Cloud Sea | Sunrise above a sea of clouds |
| `hills` | Bliss Hills | Rolling green hills and wind turbines |
| `koi` | Koi Pond | Koi among lily pads and falling petals |
| `atrium` | Atrium | A sunlit glass atrium full of plants |
| `dew` | Dewdrops | Raindrops on glossy leaves, up close |
| `orbit` | Orbit | A glossy Earth seen from orbit |
| `jellyfish` | Jellyfish | Glowing jellyfish in deep blue water |

## Layout

- `catalog.ts`: the backdrops as plain data (each folder's `meta.ts`: settings name, subtitle, post settings), with no rendering code.
- `index.ts`: pairs each meta with its lazily loaded `<Name>Backdrop.tsx`, so only the one showing is fetched.
- `shared/frame.ts`: the backdrop clock and `useBackdropFrame`, which stops while a dance stage has the screen and runs at half speed with prefers-reduced-motion; and `backdropPost`, the live post settings of the backdrop showing.
- `shared/BackdropCamera.tsx`: the camera, with slow drift and a lean towards the pointer.
- Backdrops also use the stages' shared modules: `Sky.tsx`, `Environment.tsx`, `glsl.ts`, `random.ts` and `useDisposable` in `hooks.ts`.

The game hosts them in `apps/web/src/backdrop/BackdropView.tsx`: a createPortal scene drawn through the stages' `RenderPipeline` (stage → bloom → grade → ACES) into the 640×480 buffer.

## Making one

- The menu draws the title and its buttons over the left half and the menu dancers, glass figures on a glass puck, over the lower right. Keep the left calm enough for white text, and keep the area behind the dancers mid-toned so the glass reads. Check 16:9 and 4:3 (4:3 shows more above and below).
- The buffer is 640×480 without MSAA, shown stretched to the screen: prefer bold shapes, smooth gradients and soft glows to fine detail, which shimmers.
- Move everything by the backdrop clock (`useBackdropFrame`'s `time`), never R3F's clock or `Date.now()`, in loops that never visibly reset.
- They run behind the menus on integrated GPUs, phones and the Apple TV: aim for under ~80 draw calls and ~300k triangles, instance repeated things, animate in shaders, and don't allocate per frame. In development `window.__aeroStats` reports the last frame's counts.

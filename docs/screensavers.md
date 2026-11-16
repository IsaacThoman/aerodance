# Screensavers

Aesthetic scenes that run on their own, for leaving the game up on a TV like an Apple TV
wallpaper: the glass dancers playing table tennis against the robot arm, a floating island whose
sky follows the real time of day and the real weather, the dance stages, the menu backdrops and
the skyline flight, each with its own camera views. They're the last button of
[Experiments](minigames.md), after the games.

## The screensavers

| Id | Name | Views | Scenes | Follows |
| --- | --- | --- | --- | --- |
| `sky-island` | Sky Island: a floating garden over a cloud sea, lit by the real sky and weather; a clock tower | Island, Orbit, Garden, Waterfall | | the time of day, the weather; in-scene clock |
| `table-tennis` | Table Tennis: a glass dancer rallying with the Torven robot arm in the Biodome, on the minigame's own physics; a courtside scoreboard | Broadcast, Courtside, Over the shoulder, Far end, Overhead | Dancer vs Robot, Dancer vs Dancer, Robot vs Robot | in-scene clock |
| `dance-party` | Dance Party: the glass dancers dancing on the stages; a clock made for each stage (the club's LED wall, the beach's lifebuoy…) | Stage, Circling, Close-up, Panorama | the six stages | in-scene clock |
| `skyline` | Skyline: the menus' drone flight over the Aero city | Flight, Downtown, Lake, Meadow | | |
| `cloudsea` | Cloud Sea: the time in lights on the airship | Sunrise, Airship, Pods | | in-scene clock |
| `atrium`, `aurora`, `hills`, `bubbles`, `dew`, `jellyfish`, `koi`, `orbit`, `ribbons` | The other menu backdrops ([packages/backdrops](../packages/backdrops/README.md)) | two to four each | | |

Each folder's `index.ts` lists its views; a backdrop's `Saver.tsx` flies its own camera through them,
inside what the backdrop built (they were made for one camera, so some only turn a little).

## The flow

**Experiments → Screensavers → a screensaver's preview → Start → full screen.**

- **The list** (`apps/web/src/screensavers/ScreensaverSelect.tsx`): a glass button per
  screensaver in a column on the left, six a page, **Shuffle** first. The one under the cursor
  (or the mouse) comes up behind the list after a moment, so the list is its own gallery.
- **The preview**: the screensaver's name and what it shows, its settings and **Start**, with
  the screensaver running on the right (its picture pushed right of the settings) and the clock
  in the corner. The settings, as on a game's preview (`←` / `→` on a row, or a press):
  - **View**, for a screensaver with more than one: **Auto** (the default) cuts from one view to
    the next every `cutEvery` seconds, or one view held.
  - **Scene** (or the screensaver's own name for it, like **Stage** or **Match**): what it shows.
  - **Time**: **Live** (the real time of day where the device is), **Sunrise**, **Day**,
    **Sunset**, **Night** (held still, today), or **Time-lapse** (a day every four minutes).
  - **Weather**: **Live** (the real weather there) or **Clear**, **Clouds**, **Rain**, **Snow**,
    **Storm**, **Fog**.
  - **Clock**: **Corner** (a glass chip bottom right: the time, the date and the live weather),
    **Large** (a big clock bottom left), **In scene** (the time shown in the scene itself: a clock
    on the floating island, a courtside display by the table; only on the screensavers that have
    one, `sceneClock`, and the corner chip on the others under Shuffle) or **Off**.

  Time and Weather are for the screensavers that draw them (`follows`); on the others their rows
  are dimmed. Clock, Time and Weather are shared by every screensaver; View and Scene are each
  one's own. All of them are remembered in the browser (`screensavers/options.ts`). Shuffle has
  **Change every** (1, 3, 5 or 10 minutes) instead of View and Scene.
- **Full screen** (Start): nothing but the screensaver, the clock and, as each screensaver
  comes on, a caption with its name, view and scene. `←` / `→` go to the previous or next
  screensaver (Shuffle's next), `↑` / `↓` to the previous or next view; Escape, Enter, a click or
  a tap go back to the preview. The keys show at the top for a moment after any input, the
  pointer hides while it's still, and the screen is kept awake (the Screen Wake Lock API, where
  there is one).

Shuffle goes through every screensaver in turn, each on a scenario of its own picking, and passes
over ones that don't suit the time of day (`suits`: Aurora only at night, say).

Everything works with the mouse, touch, the keyboard and the Siri Remote, like the other menus.

## The real world: time of day and weather

`screensavers/sky/` works out the sky every screensaver reads (`ctx.sky()`, a `SkyState`):

- **Where**: the device's own location once someone has pressed **Use my location** on a
  preview and the browser was allowed it (kept to a tenth of a degree in the browser), else the
  place the device's time zone is named for (`sky/zones.ts`, from the tz database's `zone.tab`),
  else a guess from the clock's offset. The preview says which ("Daylight and weather for
  Chicago, by your time zone"). Nothing asks for the location unprompted.
- **When**: the real moment, or the Time setting's: a held Sunrise, Day, Sunset or Night is today's,
  worked out within 55° of the equator so that every one of them happens (no midnight sun at Night).
  From it, the sun's and the moon's positions and the moon's phase for that place and moment
  (`sky/astro.ts`, the Astronomical Almanac's low-precision formulas), and from them `daylight`
  (0 at night to 1 by day), `golden` (the sun low but up), `phase` (`night`, `dawn`, `day`,
  `dusk`) and `rising`.
- **Weather**: the current conditions from [Open-Meteo](https://open-meteo.com/) (free, no key),
  fetched only while something shows it (a screensaver that follows the weather, or the corner or
  large clock), with the place rounded to a tenth of a degree, and kept for a quarter of an hour
  (`sky/weather.ts`). The WMO weather code becomes
  a `kind` (clear, partly, cloudy, fog, drizzle, rain, snow, storm) and amounts of cloud, rain,
  snow, fog and wind, and `lightning`. Until it comes, or when it can't (offline), the weather is
  fair and the clock shows none. Temperatures are in Fahrenheit where the device's region reads
  them so (the United States and a few others), else Celsius.

The canvas reports the sky drawn as `data-sv-sky` (`dusk|rain`).

## Making a screensaver

A screensaver is a folder `apps/web/src/screensavers/<id>/` with an `index.ts` that
default-exports its definition; `screensavers/registry.ts` finds it at build time, like the
minigames' registry, and `apps/web/tests/screensavers.test.ts` checks every folder's definition.
The contract is `screensavers/types.ts`.

```ts
// apps/web/src/screensavers/lighthouse/index.ts
import { lighthouseIcon } from '../icons.ts';
import type { ScreensaverDefinition } from '../types.ts';

const lighthouse: ScreensaverDefinition = {
  id: 'lighthouse',                       // the folder's name
  title: 'Lighthouse',
  subtitle: 'A glass lighthouse on a calm sea',
  icon: lighthouseIcon,                   // (g, cx, cy, r) => draws a monochrome icon
  views: [{ value: 'wide', label: 'Wide' }, { value: 'lamp', label: 'Lamp' }],  // Auto cuts between them
  cutEvery: 30,
  scenarios: [{ value: 'calm', label: 'Calm' }, { value: 'swell', label: 'Swell' }],  // the Scene setting
  follows: { time: true, weather: true }, // it draws ctx.sky(): Time and Weather are for it
  suits: ['dusk', 'night'],               // when Shuffle shows it (with the real time)
  sceneClock: true,                       // its lamp room has a clock: the Clock setting offers In scene
  scene: 'custom',                        // its own world (the default)
  load: () => import('./Saver.tsx'),
};
export default lighthouse;
```

What's behind it (`scene`, which can depend on the scenario):

- `'custom'`: its own world. The component renders `<SaverWorld>` (`screensavers/kit.ts`, the
  minigames' `MinigameWorld`: it takes the screen and draws through the stages'
  post-processing) and flies the world's camera from a `useFrame`, reading `ctx.view()` each
  frame. It calls `ctx.ready()` once it's built and has drawn, and the veil comes down.
- `{ background }`: the skyline flight or a menu backdrop, drawn by the menus' own Scene. Its
  component (optional) calls `useCameraViews(ctx, { <view>: shot })` to fly the backdrop's own
  camera through its views (packages/stages' `cameraPilot`, as walk mode does).
- `{ stage }`: a dance stage with its dancers looping the captured dance, flown the same way.

```tsx
// apps/web/src/screensavers/koi/Saver.tsx: a backdrop's views
import { dolly, hold, useCameraViews } from '../kit.ts';
import type { ScreensaverContext } from '../types.ts';

export default function KoiSaver({ ctx }: { ctx: ScreensaverContext }) {
  useCameraViews(ctx, {
    pond: hold([0, 14, 6], [0, 0, 0]),
    glide: dolly([-6, 4, 8], [6, 4, 8], [0, 0, 0], { seconds: 50 }),
  });
  return null;
}
```

A shot is a function of the seconds since its view began (`ctx.viewTime()`), returning where the
camera is, where it looks and its field of view (16:9; `aspectFov` keeps the width at 4:3):
`hold` drifts slowly round a place, `dolly` moves between two and back, `orbit` circles.
Keep moves slow and smooth, never visibly looping, and inside what the scene built: backdrops
were made for one camera, so other angles can find their unfinished edges.

A background or stage screensaver's component is mounted inside that backdrop's or stage's own
scene (the skyline's in the Aero world's), so anything it renders is part of the scene: lit,
fogged and post-processed with it.

**A clock in the scene.** A screensaver with `sceneClock: true` shows the time in its own world
while `ctx.clock()` is `'scene'` (the Clock setting's **In scene**; the corner and large clocks
step aside). `kit.ts` has what it takes: `useClockTexture(width, height, draw)` (a canvas
texture redrawn each minute, or second, for a screen, a sign or a scoreboard), `clockHands(date)`
(an analog clock's hands, the second hand sweeping) and `clockText(date)` (the time as the device
writes it). It's the real time, whatever the Time setting holds the sky at, and it should read at
the 640×480 buffer from a view or two.

While the list or a preview covers the left of the screen, `ctx.shift()` says how far to push the
picture right; `useCameraViews` applies it, and a custom world calls
`shiftPicture(camera, ctx.shift())` each frame. `ctx.fullScreen()` says which it is.

`ctx.report({ key: value })` puts the screensaver's own state on the canvas as `data-sv-<key>`.
A screensaver that throws while it loads or renders is caught (`ScreensaverView.tsx`): it stands
down and the rest of the game carries on.

The [backdrops' guidance](../packages/backdrops/README.md#making-one) holds for a custom world
too: the 640×480 buffer, bold shapes, bloom thresholds, NaN-safe shaders, no allocation per frame,
and the Apple TV's budget (no JIT: keep draw calls and objects few).

## How it works

- `screensavers/host.ts` (`ScreensaverHost`) holds what's showing and what's wanted, the veil
  between screensavers (up, swap, wait until the new one is ready and has drawn a few frames,
  down), Auto's cuts, Shuffle's turns and the picture's shift. App makes one and hands it to:
- `screensavers/ScreensaverView.tsx`, always mounted in the game's `<Canvas>`: it steps the host
  each frame, mounts the showing screensaver's component with its `ctx`, draws the veil, and
  watches the menus' Scene (`data-background-ready`) or the stage (StageView's state) for a
  background or stage screensaver's scene being ready. App draws those scenes: the Scene's
  `background`, or StageView with `demo` dancers.
- `screensavers/ScreensaverSelect.tsx`: the list, the preview, and full screen's clock, captions,
  keys, wake lock and hidden pointer.
- `screensavers/clock.ts` draws the clock and captions; `layout.ts` lays the screens out
  (play.ts targets: `svTile.<n>`, `svOptionNext.<n>`, `SV_START`, `SV_LOCATE`, `SV_BACK`).

## Testing

`apps/web/tests/screensavers.test.ts` checks every definition, the settings, the layout, the
sky (sun and moon, sunrise and sunset, the held times, time zones, the weather codes) and the
host's veil, cuts and Shuffle.

With [`scripts/play.ts`](interactive-testing.md), `/?screensaver=<id>` opens a screensaver
full screen, with any of its settings for the visit: `&view=`, `&scenario=`, `&time=`,
`&weather=`, `&clock=`, and `&every=` for `shuffle`. `&place=<lat>,<lon>` shows another place's
sky. `start --url` and `goto` wait until it's showing.

```sh
node scripts/play.ts start --url '/?screensaver=sky-island&time=sunset&weather=rain&clock=off'
node scripts/play.ts shot --frame
node scripts/play.ts key ArrowRight          # the next screensaver
node scripts/play.ts wait svReady=true svShown=dance-party
node scripts/play.ts key Escape              # the preview
node scripts/play.ts click svOptionNext.0    # step its first row
```

The canvas reports `data-sv-screen` (`list`, `preview`, `running`), `-sv-select-ready`,
`-sv-list`, `-sv-page`, `-sv-chosen`, `-sv-options` (`view=auto|time=live|…`), `-sv-option-rows`,
`-sv-shown`, `-sv-scenario`, `-sv-view`, `-sv-ready` (the veil down on the one wanted),
`-sv-sky` and `-sv-clock` (the Clock as it applies: `scene`, `corner`, `large`, `off`), and each
screensaver's own reports.

# Landing page

The page that introduces aerodance and sends people to where they can get it. It's a static site
of its own, apart from the game.

```sh
npm run site:dev       # http://localhost:5178
npm run site:build     # into apps/site/dist
npm run site:preview   # serves the build at http://localhost:8083
```

It's plain HTML and CSS with a little TypeScript, built by Vite (`vite.config.ts`). There's no
framework: everything on the page can be read without JavaScript, which adds the motion and the
interactive pieces (the controls that need it are hidden without it). CI builds it with the rest
(`npm run site:build`).

## Where things are

- `index.html`: the whole page, section by section.
- `site.config.ts`: where every button goes. `index.html` names these as `{{key}}`, and the build
  fails on a key that isn't there. **The App Store, Apple TV and Steam links are placeholders that
  go to the repository** until the listings exist: change `appStore`, `appleTv` and `steam`. `site`
  is the page's own address, for its canonical link and social card; `play` is the game in a
  browser. Those two are the same address for now ([Deploying](#deploying)).
- `src/styles/`: `index.css` has the tokens (colours, type, spacing) and imports the rest:
  `components.css` (wordmark, buttons, store badges, orbs, the phone drawing, nav), `hero.css`,
  `sections.css` (features, platforms), `stages.css` and `closing.css`.
- `src/*.ts`: one small module for each thing that moves. `hero.ts` (the TV's video, and the
  dancers and sky drifting as the page scrolls), `bubbles.ts` (the hero's soap bubbles),
  `stages.ts` (the stage viewer), `chrome.ts` (the nav), `motion.ts` (whether
  the page should hold still, and the pause buttons that share that state) and `codec.ts` (which
  of the videos' two encodings, AV1 or H.264, the page plays).
- `media/`: the pictures and video, described below. `public/`: the icons, `og.jpg` (the social
  card, 1200×630) and `robots.txt`.

## The look

It follows the game's own drawing kit (`apps/web/src/ui/draw.ts`): Inter, with headings in the
wordmark's two weights (200 and 800) and its mint square for a full stop; navy ink (`#0c2f52`); glossy aqua
glass; the four players' colours; and each stage's
accent colours (`packages/stages/*/meta.ts`) on its tab.

The hero's sky is the game's own: the title screen's world, rendered in its engine from above the
clouds (the sun and its lens flare, the cirrus, the hot-air balloons, the cloud layer and the peaks
through it are all the game's). The bubbles that drift up it are the game's soap bubble as a sprite.

The page has one paused state (`motion.ts`), and every pause button on it, the hero TV's and the
stage viewer's, shows and sets that one: pausing any of them stops everything that moves by itself
(the videos, the bubbles, the stage tour, the parallax and the CSS animation), and playing any of
them starts it all again. A pause is remembered for the next visit. The page starts paused for
`prefers-reduced-motion`, and a press of play then starts it for that visit only. It also pauses
when a browser refuses to autoplay the hero's video, until a tap plays it. When the browser is
saving data, the videos wait for a press of play. The stage viewer's tabs change stage while it's paused, and they
work from the keyboard (left and right, Home, End). Text is at
least 4.5:1 against what's behind it, measured on the rendered page: keep it so when changing a
colour or a picture that text sits on.

The stage viewer changes stage with a 0.6 s crossfade between two clips that are both playing
(`FADE` in `stages.ts`, which `stages.css` reads as `--fade`). The next stage's clip is fetched
whole while the one before plays, started out of sight a second before it's due, and shown only
once it's playing (it has fired `playing` and shown new frames); the clip on show fades out over it
and plays on until it's gone. A clip that isn't ready leaves the one on show playing, round again if
need be, so a slow connection makes the tour wait but never stop on screen. The tour runs on the
clip on show's own clock, not a timer: each clip comes in 0.6 s before the end of the one before,
the overlap the clips are cut for. A pressed tab is chosen at once and its stage comes in the same
way as soon as its clip plays; while the tour is stopped it brings the stage's still (with a cut, if
the page is holding still). At most two
clips play at once, and two only while one comes in.

On a phone (480 px wide or narrower, or a phone on its side) the nav slides up out of the way
while the page scrolls down and comes back as it scrolls up; it stays at the top of the page and
while the keyboard is in it, and on an iPad or a computer it never moves. Links within the page
land their section 24 px from the top there (96 px elsewhere): a jump down slides the nav away,
and after a jump up the light sections' own top padding keeps their headings clear of it. The bar
slides inside a box clipped 6 px below the window's top, as Safari would otherwise take it for a
header fixed to that edge and tint its status bar the hero's blue for the rest of the visit
(`components.css` has the details).

The game calls its minigames **Experiments** on its menu, so the page does too. And the page
doesn't say how many stages there are, because more are coming: the viewer shows the ones it has
without counting them.

## Media

Every picture of the game is the game itself, the hero's sky included.

| File | What | How it was made |
| --- | --- | --- |
| `sky/wide-2100`, `wide-4200` (`.avif`, `.webp`) | The hero's sky: the wide render, at two sizes. | The Aero world (`apps/web/src/aero`, the title screen's) through its standalone renderer `createAeroBackground`, which draws at any size: 4200×2800 with antialiasing, its camera held above the cloud layer at (404, 291, −80), turned 7° left of the flight's heading there and looking 19° up with a 64° lens, which puts the sun in the top right corner and a hot-air balloon either side of where the TV stands. Its own bubbles and gulls are left out, and the balloons' rigging and burner flames are the render's own (wires from the envelope's mouth to a burner frame and the basket, a layered flame), more detailed than the game's. Then graded: see below. |
| `sky/tall-1200` (`.avif`, `.webp`) | The same sky for phones (560 px and narrower): taller, the sun just out of frame. | An earlier pose of the same scene, 1200×2400: from (380, 291, −30), turned 9° right and looking 20° up with a 62° lens, bubbles and gulls left out. |
| `sky/bubble.webp` | The soap bubble that drifts up the hero. | One of the Aero world's bubbles drawn alone, over black and over white, and its colour and transparency solved from the pair. Flipped, so its glint faces the page's sun. |
| `hero.mp4`, `hero-sm.mp4`, `hero.webp` (and `-av1.mp4` of each video) | The TV in the hero: 20 s of two-player play on `falls`, `club`, `openreef` and `beach`, with the HUD. `-sm` is for phones; the `.webp` is its first frame; `-av1` is the same video in AV1 (below). | The game played by its autoplay ghost (`?input=ghost`, one player lagging so the scores differ), each frame of the canvas copied on `requestAnimationFrame` and read back as PNG. The four stages are four runs of one song, cut at the same song times, so the routine carries on across each cut. For the capture the ghost players were stood close to a 4:3 camera, side by side, so the camera panel at the top of the screen shows them the size real players are. (Left alone the ghost copies the routine's own framing, and this routine was filmed upright from across a room, which leaves two specks in the panel.) |
| `stages/<id>.mp4`, `-av1.mp4`, `.webp`, `-thumb.webp` | The stage viewer: 7 s of each stage (exactly 420 frames) in H.264 and in AV1, its first frame, and that frame small for its tab. The clips are made to crossfade into one another in the tour's order (Open Reef, Falls, Beach, Club, Sanctuary, Atrium, and round again), each starting 0.6 s before the last one ends. | The song preview of each stage with the UI hidden (`?input=ghost&diag=noui`), captured the same way, the camera flown by the capture instead of the game. Every clip is the same camera move, so each crossfade reads as one move: the camera circles the dancers from left to right at a constant speed with no easing at either end, at the same distance and height, and frames the dancers the same on every stage (it's set in the dancers' own size, so Atrium's smaller ones too). The pair turns with it, as if on a turntable, so they face the camera all the way round and overlap exactly through each crossfade: only the world changes behind them. It turns 3° a second, 21° over a clip, except where the scenery asked otherwise: Club turns 4.5° and Atrium 3.5°, as their walls stand close behind the dancers and would otherwise slide by slower than the other stages' scenery, and Sanctuary's arc starts 8° further round, which keeps the purple dancer off its pale glass tower. The clips are one song in consecutive stretches, from 13.217 s and each 6.4 s on from the last, so the routine carries on through each crossfade. Only the loop from Atrium back to Open Reef changes the dancers' pose, as the routine never repeats itself. |
| `screens/tv.webp`, `iphone.webp`, `laptop.webp`, `ipad.webp` | The screens in the device drawings. | Frames of the hero's captures (club, beach and reef); the iPad's is the game in its 4:3 mode, on `sanctuary`, captured the same way. |
| `screens/phone.webp` | The phone camera page, a code half typed, filling the screen of the phone drawing: the features grid's, and the same drawing smaller by the TV under "Pick a screen" (`.phone` in `components.css`, which each sizes and places). | The whole 402×874-point screen of a 6.3-inch Pro phone, 804×1748. The `/pair/` page captured sharp at 402×778 CSS px and DPR 3 (1206×2334), with the game's phone buffer cap lifted for the capture only (`PHONE_LONG_SIDE` 2400 and `phoneBuffer` scaled by `devicePixelRatio`; that patch and the steps are in `concepts/landing-page/phone/screen/` outside the repo), the code `19308` typed. It goes 186 px down a 1206×2622 frame of the page's own flat background (`#1f6fd6`), so the 62-point status bar band and the 34-point home-indicator band are the same colour with no seam, then is scaled to 804×1748 (ffmpeg, Lanczos) and encoded with `cwebp -q 90 -sharp_yuv -m 6`. The page draws the status bar, the Dynamic Island and the home indicator over it in CSS. |
| `screens/studio.webp` | Dance Studio with a project open. | A screenshot of Dance Studio. |
| `screens/table-tennis.webp` | Table Tennis. | The minigame with the puppet camera (`?input=puppet&diag=noui`). |
| `screens/closing.webp` | The still behind the closing section. | A crop of `assets/beach-hero-no-logo.png`. |
| `tv.webp` | The hero's TV: a glossy navy set in a crystal rim, a pearl webcam on top, on the menu's glass puck, its screen cut out for the video. 2400×1639 with transparency. | Rendered in Blender by `art/tv.py` (`blender -b -P apps/site/art/tv.py -- tv.png 2400 512`): Cycles, a transparent film with transparent glass, the screen a holdout, lit and reflecting the hero's sky. The camera looks straight at the screen and is shifted down, so the screen stays an exact rectangle. The script prints where the screen lands in the picture; `hero.css` (`--tv-l`, `--tv-t`, `--tv-w`, `--tv-h` on `.tv`) places the picture round the video by those numbers, so after a new render copy them over. WebP at quality 90, alpha at 100, `-sharp_yuv`. |
| `dancers/*.webp` | The four glass dancers round the hero's TV, cut out (`-sm` at half the size; the two behind the TV only come in that size). | Rendered in Blender from the character model with its glass material, posed by hand, on a transparent film. |
| `crew/crew.avif`, `crew.webp` | The players card's four dancers: the game's players screen set to four, the glass dancers on their glass puck, each caught mid-move, with real transparency. 1120×840; the AVIF (40 KB) for browsers that take it, the WebP (98 KB) for the rest. | The menu dancers themselves (`apps/web/src/menu/MenuDancers.tsx` with `count={4}`, its file unchanged) in the game's engine, on a capture page that steps the clock by hand. Each dancer is held at its own moment of the menu's dance capture (`packages/character/assets/dance.adpose`, 14 s), the one where its pose reads most as dancing with every face in view: player 1 (blue, left) at 4.9375 s, hands up by its face with one arm flung out; player 2 (purple, right) at 3.125 s, mid-step, body tilted over its spread feet; player 3 (green, front) at 9.5 s, leaning, one hand raised and the other out low; player 4 (pink, back) at 9.125 s, an arm out at head height. No one moment of the menu's own arrangement (players 3 and 4 dancing 3.5 s behind 1 and 2) had all four like that: in most, green, in front, stood still or hid pink. The capture page holds them there by having MenuDancers' playback line read the four times (a transform in its dev server; the pose is the game's own sampler at that time). The puck is level (its sway at rest). The game's own camera, cropped with a view offset to 1120×840 around the puck (from (1360, 536) in its 16:9 frame at 2560×1440), so it's seen exactly as in the game, a little from above; drawn at twice that size and averaged down. The frame is drawn twice, over black and over white, and its colour and transparency solved from the pair (alpha = 1 − (white − black)), as the glass is see-through. Colour under nearly transparent pixels is eased to the card's blue, so the encoders bleed that, not black, into the edges. AVIF at quality 60, 4:4:4, effort 9 (sharp); WebP at quality 90, alpha lossless, `smartSubsample`. The capture page and scripts are in `concepts/landing-page/crew/` outside the repo. |

The game draws 640×480 and stretches it to 16:9, so `hero.mp4` and the stage clips keep that: each
is the game's picture at exactly twice the size (1280×960), flagged as 4:3 pixels so it plays at
16:9 (`scale=1280:960:flags=neighbor,setsar=4/3`). Scaled from that, the game's pixels stay sharp;
the stage viewer also asks for `image-rendering: pixelated`, and the page sizes these videos
itself, without relying on that flag. The stage stills are the same frames at four times
(2560×1440). `hero-sm.mp4` is 960×720 at 30 frames a second with the same flag.

They're encoded to look clean more than to be small: x264 `-preset veryslow`, `-crf 21` for the
hero, `24` for the stage clips, and `27` for `hero-sm.mp4`; the stills and
screens are WebP at quality 92 with `-sharp_yuv`. Sharp doubled pixels at 60 frames a second cost a
lot of bits (at `-crf 30` the picture smeared), so the hero is about 17 MB, the stage clips 2 to
8.5 MB each (Falls, its meadow sliding past, the most): `media/` is about 52 MB in all, and 77 MB with the AV1 copies below. Only the hero's video loads with the page. A stage's
clip is fetched whole, one ahead: the first as the stage viewer nears the screen, each next one
while the one before it plays, and any whose tab is pointed at, focused or pressed (none while the
page is paused or saving data). The players card's dancers (a 40 KB still, loaded lazily) load
when the card nears the screen.

Every video is also in AV1, next to it with an `-av1` suffix (`hero-av1.mp4`, `hero-sm-av1.mp4`,
`stages/<id>-av1.mp4`), in about half the bytes at the same quality: 24.8 MB for the eight against
48.0 MB, so the hero and the whole tour come to 22.4 MB on a computer instead of 43.1. They're
SVT-AV1 at its slowest preset (0), 8-bit 4:2:0, from the same lossless frames through the same
filters (the doubling and the 4:3 flag kept), each at the highest crf at which it's at least as
good as its H.264 file on two counts against those frames: VMAF, and the PSNR of the colour planes.
VMAF only sees brightness, and matched on it alone, AV1 lost colour detail H.264 kept: Falls' small
yellow flowers in the grass and Beach's soap bubbles faded into what was behind them. SVT's
temporal filter is turned down (`tf-strength=1`) for the same reason. A stage clip has a single
keyframe, at its start, where the viewer always starts it; the hero has one at each of its four
stage cuts (every 5 s), so a loop, or a resume after the browser has let its decoder go, starts
clean. The recipe, its numbers and the script for the side-by-side crops it was judged by are in
`concepts/landing-page/capture/av1/` outside the repository.

`src/codec.ts` chooses between the two, once for the whole page: AV1 where the browser's
MediaCapabilities says it plays the hardest of the files (Falls: 1280×960 at 60 frames a second,
6.7 Mbit/s) smoothly, and on a phone or a tablet (a screen without hover) power-efficiently too,
which is to say in hardware, as AV1 in software at that size can stutter on a slow phone and runs
its battery down; H.264 anywhere else, and where the browser can't say. Safari on a device without
an AV1 decoder says it isn't supported. In `index.html` each video lists its AV1 source first,
then its H.264 one, each typed with its codecs as read from the file (`av01.0.09M.08` is 1280×960
at 60, level 4.1; `av01.0.05M.08` is `hero-sm`; `avc1.640032` and `avc1.640028` the H.264), and
preloads nothing. With the script, before any of it loads, each video gets as its `src` the source
of the page's choice the browser would have taken (the first whose `media` matches) and loses its
`<source>`s; then the hero preloads its metadata, as it always did. So no video is ever fetched in
both. (It's `src`, not a call to `load()`: Chrome takes `load()` as asking for the video, and
fetches it whatever its preload says.) Without the script the browser plays the first source it
can. A video encoded again needs its codecs checked against the file, in `index.html` and, for
the hardest, in `codec.ts`.

The sky is the exception to the pixels: it's drawn at full size, smooth, as the glass dancers
standing in it are. It's also **graded**. The game's sky is too bright a blue for white text (about
3:1 where the copy sits), so a deep blue is laid over its upper two thirds (38% at the top, 70%
behind the copy, gone by the cloud tops). The sun keeps a round hole in that, and the balloons are
cut out of it exactly, so they stay as rendered. The picture's foot is run out to the page's own
colour, so the clouds become the page.

The copy must stay over the graded part and clear of the sun, and where it sits over the picture
depends on the window. From 1000 px wide the headline is one line; narrower, it's two. And
everything above the TV is sized by the window's height as well as its width, for short laptop
screens. The render was composed for that: its sun is just past the end of the one-line headline
at every desktop size. After changing the hero's layout, the render or its `object-position`,
measure the contrast again across widths and heights.

From 1000 px wide the hero is also made to the window's height, so that nothing is cut off at the
bottom of the first screen (`hero.css`, at `.hero__set`). The TV and its dancers are one box, the
set, which takes whatever height the copy leaves. In a window 840 px tall or more, the first
screen ends with the "Available on" row; in a shorter one it ends under the TV, with the row next
down. The TV's screen is at least 560 px wide.

The song bundle the captures play isn't in the repository.

## Deploying

The build is static files with absolute paths (`/assets/…`), so serve `apps/site/dist` at the root
of a host. It isn't deployed anywhere yet, and where it goes is still to decide: the game itself
is at [aerodance.party](https://aerodance.party), and `site.config.ts` gives that address for both
`site` and `play`. Before deploying, give the page and the game different addresses there, or
"Play in your browser" will lead back to the page.

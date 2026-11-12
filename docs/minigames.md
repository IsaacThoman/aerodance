# Experiments

Short games played with the body, from the main menu's **Experiments** (beside Start): a list of
compact glass buttons, each game's preview with its settings and players
dial, then the game. The platform around the games (`apps/web/src/minigames/`) does everything
they share: the list, each game's settings, the camera and its calibration, the how-to card, the
3, 2, 1, pausing, the HUD, the results and best scores, a pose API built for games, and a puppet
camera to test them with. A game is one folder; adding one changes no other file.

The **Experiments** button only shows while there's a game to play. **Table Tennis** is the first game,
played as Wii Sports Resort's is: a match is first to 6 points by 2 clear (`table-tennis/match.ts`),
the table in the Biodome ([arenas](../packages/arenas/README.md); `?scene=debug` for a plain room).
Alone, the opponent is a robot arm from the robot hall ([robots](../packages/robots/README.md)) that serves and returns
(the **Opponent** setting), or the **Mode** is Return Challenge: return its serves, quicker every few,
until one gets by. Two players split the screen, one at each end of the table in first person, and play
a match, each seeing the other as their glass dancer holding the paddle. A player serves by raising
their free hand to toss the ball and swinging through it as it comes down (`table-tennis/rally.ts`).
The **Controls** setting is Easy by default, as Wii Sports Resort plays: seen from behind each
player's dancer, which steps across to meet the ball, a swing timed to the ball's arrival hits it
wherever the hand is, early or late timing sending it across or down the line (`table-tennis/easy.ts`).
**Precise** is first person: the paddle is where the hand puts it, with the aim assist helping.
Easy's view is one of `VIEWS` in `table-tennis/Game.tsx` (close behind the dancer by default; over
the shoulder; low, behind the hands; first person; high, as Wii Sports Resort's): `?view=<id>`
picks it, and V while playing steps through them (`mgView` says which).
Its HUD is Wii Sports Resort's too (`table-tennis/Hud.tsx`, what it says in `table-tennis/calls.ts`):
a score bug under the pause icon, a call where each point was decided (OUT, NET, NICE!…),
banners for whose point it was, DEUCE, MATCH POINT and GAME!, and prompts only while they're needed.

## The flow

**Experiments → a game's preview → Play → calibration → how to play → 3, 2, 1 → the round →
results → Play again or Experiments.**

- **The list** (`minigames/MinigameSelect.tsx`): four compact buttons per page in a left
  column, with a static monochrome icon and the game's title. The menu dancers stay on their
  platform on the right. More than four games page with the arrows under the column.
  Up and Down move through the buttons; Left and Right change pages.
- **The preview**: the game's title, its settings on the left ([options](#settings-options)),
  a players dial and **Play** below them, and the menu's glass dancer platform on the right,
  showing the selected player count. The dial only permits counts the game supports; for a solo
  game it shows one with both arrows dimmed. Scored games show the best under the title.
  Back from a round lands here, with the same players and settings.
- **Calibration** (`minigames/MinigameScreen.tsx`): the song game's camera setup card
  (`game/calibrationCard.ts`): the preview starts the camera, the arrows pick a webcam, a phone
  or the puppet, and every player holds still together for 2.5 seconds, which measures each
  one's body (`game/webcamCalibration.ts`). Shoulders and hips in view are enough, so players can
  stand close to the camera, unless the game asks for feet too (`fullBody`, as the songs do). No
  camera can't play a minigame: the card asks for one.
  Replays (`?input=ghost`) skip it.
- **How to play**: the game's steps, each with an icon, then **Start**, or any player holding a
  hand above their head for 0.8 seconds. Missing players are named.
- **The round**: the HUD shows each player's score in the top corners (as in a song; three or
  four share them) and a timed round's seconds left under the pause icon at the top centre, and
  nudges anyone out of view. Escape, the pause icon, a hidden tab or an interruption (the audio
  taken for a call, the camera muted: `game/interruptions.ts`) pauses: **Resume** counts down
  again, **Restart** starts the round over (with calibration), **Experiments** leaves. A timed round
  ends itself with **Time's up!**; others end when the game says.
- **Results** (`minigames/MinigameResults.tsx`): the winner, the solo score or a co-op team's, a scoreboard in
  finishing order (a solo player's opponent under them: `minigames/resultsBoard.ts`), **NEW BEST!** when the top score beat the game's best for this many players
  (`minigames/bestScores.ts`, saved in the browser), **Play again** and **Experiments**.

Everything works with the mouse, touch and the keyboard (the pearl focus ring, Enter, Escape),
like the other menus, and with the Siri Remote in the Apple TV app.

## Making a game

A game is a folder `apps/web/src/minigames/<id>/` with an `index.ts` that default-exports its
definition. `minigames/registry.ts` finds every such folder at build time (`import.meta.glob`),
so nothing else needs editing; `apps/web/tests/minigames.test.ts` checks each definition.

```ts
// apps/web/src/minigames/high-five/index.ts
import type { MinigameDefinition } from '../types.ts';
import { handIcon } from './icons.ts';

const highFive: MinigameDefinition = {
  id: 'high-five',                       // the folder's name; best scores are saved under it
  title: 'High Five',
  players: [1, 2],
  howTo: [                               // the how-to card: one to four steps
    { icon: 'bubbles', text: 'Slap each hand as it glows' },
    { icon: 'replay', text: 'Most high fives in 45 seconds wins', players: [2] },  // only with two
  ],
  icon: handIcon,                        // (g, cx, cy, radius) => draws a static monochrome icon
  score: { unit: 'fives' },              // or { better: 'lower', format: (ms) => `${(ms / 1000).toFixed(2)} s` }
  durationMs: 45000,                     // a timed round: the host counts down and ends it
  scene: 'menu',                         // what's behind the game (below)
  options: [                             // settings chosen on the preview (below)
    { id: 'speed', label: 'Hand speed', choices: [{ value: 'slow', label: 'Slow' }, { value: 'fast', label: 'Fast' }], default: 'slow' },
  ],
  load: () => import('./Game.tsx'),      // the game itself, fetched when it's picked
};
export default highFive;
```

The definition loads with the menus, so keep it small: the icon and any drawing it uses go in
`.ts` files (Node runs the tests that import it); the game, its 3D and its assets come in through
`load`. The fields are in `minigames/types.ts`: also `hud` (turn
the host's scores or timer off to draw your own), `fullBody` (calibrate only with feet in view, for
games about legs), `tracking` (`'world'`: MediaPipe's 3D world landmarks; `'hands'`: those and
the tracked hands too, for a game that does its own geometry; or a function choosing per round
from its player count and settings), `coop` (the players are a team: give everyone the team's
score, and the results show it as one instead of naming a winner; a game whose players choose
together or versus once it's started says so with `ctx.setCoop`), `best: false` (open play: a
game that never finishes a round with a score, so its preview shows no best), `order`
(lower lists first, then by title) and `devOnly`. A how-to step with `players` shows only
with those player counts, for a game played differently alone and together; every count needs
one to four steps.

The game is a component rendered inside the game's one `<Canvas>` for the whole session, from
calibration to results, with the session's `MinigameContext` as its `ctx` prop (or
`useMinigame()`):

```tsx
// apps/web/src/minigames/high-five/Game.tsx
import { useMinigameFrame, useMinigameOverlay } from '../hooks.ts';
import { MirrorCharacters, cameraArea, toDesign } from '../scene.tsx';
import { handAt } from '../pose/gestures.ts';
import type { MinigameContext } from '../types.ts';

export default function HighFive({ ctx }: { ctx: MinigameContext }) {
  useMinigameFrame((frame) => {
    if (frame.phase !== 'playing') return;          // frame.dt is 0 otherwise
    const fast = ctx.options.speed === 'fast';       // the preview's setting
    for (const p of frame.players) {
      if (!p.present) continue;
      const hand = handAt(p, 'right');               // body space: torso lengths from the hips
      if (hand.y > 1.6) ctx.addScore(p.id, fast ? 2 : 1);
    }
    for (const e of frame.events) if (e.type === 'clap') { /* a clap: e.player */ }
    ctx.report({ targets: 3 });                      // data-mg-targets, for play.ts and tests
  });
  useMinigameOverlay({ draw: (g, ui, frame) => { /* design units, as the menus */ } });
  return <MirrorCharacters scale={0.8} />;           // everyone's glass self, as a mirror
}
```

### Settings: `options`

A game with settings (a difficulty, an aim assist, which hand holds the paddle) lists them in its
definition's `options`, up to five, and its preview shows a row for each on the left: the
label, then the choice between two arrows that step through the choices and round again, as the
camera picker's do. A press on an arrow steps it, and a press on the row steps it on; with the
keyboard or the Siri Remote, Up and Down go through the rows, the players dial and Play, and
Left/Right step the row with the focus ring (Enter steps it on). The game's icon appears on its list button.

```ts
options: [
  { id: 'bot', label: 'Opponent', choices: [{ value: 'easy', label: 'Easy' }, { value: 'medium', label: 'Medium' }, { value: 'hard', label: 'Hard' }], default: 'medium' },
  { id: 'hand', label: 'Paddle hand', choices: [{ value: 'right', label: 'Right' }, { value: 'left', label: 'Left' }], default: 'right' },
],
```

Ids and values are letters, digits, hyphens and underscores; no two options share an id, and each
has two or more choices (no two with the same value) with its default among them. The definition
test checks all that. Keep the labels short: in 4:3 a row's label has about 200 design units and
its choice about 150, shrinking a little before they're cut short. Each game's choices are remembered in the browser (`minigames/options.ts`): a saved
option the game no longer has is dropped, and a value it no longer offers is back at its default.

The round has them as `ctx.options`, every option present, as chosen when Play was pressed:
`ctx.options.bot === 'hard'`. `ctx.setOption('bot', 'easy')` changes one at once, for a key that
changes a setting mid-round; it's saved, so Play again and the game's next preview start on it.
An id or value the game doesn't offer is ignored.

An option with `players` (some of the game's counts) is for those counts only: with others the
preview dims its row and the focus passes over it, and the game should ignore it. Table Tennis's
robot settings are `players: [1]`. Its row stays where it is, so the dial and Play don't move as
the count changes.

An option with `perPlayer: true` is each player's own (Table Tennis's **Paddle hand**): its row
has a chip per player in their colour, which a press (or Enter) steps on; Left and Right go
between the chips. Each player's choice is `ctx.options['<id>.<player number>']`
(`paddleHand.2`; `playerOption(game, ctx.options, id, player)` in `minigames/options.ts` reads it
with the player 0-based), remembered in the browser like any other. A preview has room for five
rows (five sit a little closer than four).

With play.ts, `click mgOptionNext.<i>` (or `mgOptionPrev.<i>`, or the row, `mgOption.<i>`) steps
the preview's row i (a per-player row's chip: `mgOptionPlayer.<i>.<player>.<players>`), and the canvas reports them all: `wait minigameOptions~opponent=hard`.

### What the host does, and what the game does

The host (`minigames/MinigameSession.ts`, drawn by `MinigameScreen.tsx`) runs the round: its
phases (`loading → calibrating → howto → countdown → playing ⇄ paused → finishing → results`),
the clock (`ctx.timeMs()`: play so far, standing still while paused and before the countdown
ends; `ctx.remainingMs()` for timed rounds), the players' poses and gestures, the scores the HUD
shows and the results it saves.

The game:

- reads `frame.phase` and moves only while `playing` (`frame.dt` is 0 otherwise, so motion that
  multiplies by it stops by itself during the countdown and a pause);
- keeps score with `ctx.addScore(player, points)` / `ctx.setScore`, and ends an untimed round
  with `ctx.finish(scores?, outcome?)`; the outcome says what the scores can't: a `headline` for
  the results (a team's win) in a `player`'s colours, `coop` for a round played together (one
  team score, for a game whose modes differ round to round), `best: false` to keep a round
  (a match's points) out of the best scores, `timeUp` for a round its own clock ended ("Time's
  up!" rather than "Finish!", as a `durationMs` round says), `opponent` for whom a solo player played
  against (`{ name: 'Robot', score: 6 }`: a row of its own on the results board, under theirs);
- reads its settings in `ctx.options` ([settings](#settings-options));
- keeps its per-frame state in refs, not React state (the component re-renders only when the
  phase changes);
- reports what a test needs with `ctx.report({ key: value })` (`data-mg-<key>`; `null` clears it);
- doesn't handle Escape, pausing, the camera or the results: those are the host's.

A game that throws is caught (`MinigameView.tsx`): the round stops with an error and a way back
to Experiments, and the rest of the game carries on.

Frame order (useFrame priorities): the host's update (−1: this frame's poses, gestures and
phase), the game's `useMinigameFrame` callbacks (−0.5), the background or the game's world or
stage (1), `MinigameLayer` (1.5), `MirrorCharacters` (1.55), the game's overlay (2.1), the
host's HUD and screens (2.3), the results (2.5).

## Drawing

The canvas is a fixed **640×480** buffer stretched to the display: 4:3, or anamorphic 16:9
([developer guide](README.md#aero-background)). The 2D layers are laid out in design units:
**1600×900** in 16:9 and **1200×900** in 4:3 (`displayDesign(size.width, size.height)` gives the
current one), and a game must look right in both: lay things out from the width, keep text and
targets clear of the top corners (the HUD's scores) and the top centre (the pause icon and timer).

### What's behind the game: `scene`

| `scene` | Behind the game | Use it with |
| --- | --- | --- |
| `'menu'` (default) | What the menus show, carrying on: the skyline flight (or the backdrop a `?background=<id>` visit shows behind the menus) | 2D games, `MirrorCharacters`, `MinigameLayer` |
| `{ background: 'koi' }` | The skyline flight (`'skyline'`) or one of the [menu backdrops](../packages/backdrops/README.md), the game's own choice | the same |
| `{ stage: 'club' }` | A [dance stage](../packages/stages/README.md), without its dancers; the game's component renders inside the stage's scene, with its camera, lights and post-processing | `LiveCharacter`, the game's own 3D things |
| `'custom'` | Nothing: the menu's world stands down and the game draws its own | `MinigameWorld` |

The stage and backdrop are mounted and compiled out of sight first and unveiled once ready, as
for a song. On a stage, `useThree`'s camera is the stage's (its `StageCamera`), and the stage's
floor is where its dancers stand (`meta.dancers` in `packages/stages/<id>/meta.ts`).

### The pieces (`minigames/scene.tsx`, `minigames/hooks.ts`)

- **`useMinigameOverlay({ draw })`**: the game's 2D layer, a canvas overlay like the menus'
  (`ui/useCanvasUI.ts`), drawn every frame of the round in design units, under the HUD. Draw with
  the aero kit in `ui/draw.ts`: `drawGlassButton`, `drawDarkGlassPanel`, `drawHeadline`,
  `drawShadowText`, `drawCaps`, `drawProgress`, `drawDancer` (a dancer cutout), `ICONS`. `widgets`
  and `onActivate` take taps and clicks while playing, for the rare game that wants them.
- **`<MirrorCharacters fit scale anchor />`**: every player's glass character where they stand
  in the camera's picture, over the screen like a mirror. With `fit="cover"` (the default) the
  picture fills the screen; `cameraArea(w, h, aspect, fit)` gives the same rect, and
  `toDesign(point, area)` maps the pose API's screen points onto it, so a game's targets line up
  with the characters. The characters are legless blobs with big heads and floating hands:
  `anchor="hips"` (default) lays each over its player so the hands come near theirs, and
  `scale` (0.8 suits most) keeps them from crowding the screen. Draw your own hand markers where
  precision matters: the pose's wrists are exact, the character's hands only near.
- **`<LiveCharacter player={0} />`**: one player's glass character copying them, standing at its
  group's origin, a torso about 1.05 units long, for a world, a layer or a stage. Mirrored (their
  right hand on the screen's right) unless `mirror={false}`.
- **`<MinigameLayer camera={{ position, target, fov }}>`**: 3D things over the background, with
  their own camera, studio reflections and lights, drawn in ACES like the menu dancers.
- **`<MinigameWorld camera background post shadows>`**: a world of its own (scene `'custom'`),
  drawn through the stages' pipeline (bloom, grade, ACES; `post` changes it) at priority 1.
- **`<MinigameWorld views={[cameraA, cameraB]}>`**: a split screen, a camera each (set up as
  `camera` is) for two to four views: two side by side, left to right, three or four in a two by
  two grid. Inside, `useThree`'s camera is a `SplitCamera` (`packages/stages/shared/post.tsx`)
  whose `cameras` are the views (`viewCamera(camera, i)`); each is culled for itself, gets its own
  vignette, and costs the world's draw calls again (shadow maps are drawn once, with the first
  view). Put player 1 in the left view: they stand on the left of the mirror.
- **`<SeenBy views={[1]}>`**: things only some views draw, such as a first-person player's own
  body, which the others see but which would fill its owner's view from inside. A world with one
  view is view 0. They go on the views' own layers and cast no shadows (the shadow maps are drawn
  once, for every view): give anything whose shadow matters a stand-in outside it that draws
  nothing (`colorWrite: false`) but casts it. Table Tennis
  does this for each player's first-person hands and gives the other player a bigger mitt in their
  dancer's proportions, holding the same paddle.

## The pose API

Each player's pose is a `PlayerPose` (`minigames/pose/body.ts`) in `ctx.players` and
`frame.players`, updated as poses arrive (the same records the song game scores). The screen is a
mirror, so everything is from the player's side: their right hand is on the right of the screen.

| Field | |
| --- | --- |
| `present` | A pose arrived in the last 400 ms |
| `calibrated` | Body space is measured against the calibration (always, once the round starts) |
| `confidence`, `jointConfidence[i]` | How sure the model is, 0–1: the torso's, and each landmark's |
| `screen[i]` | The landmark on the mirrored camera picture: 0–1 left to right, top to bottom |
| `body[i]` | Body space: torso lengths (shoulder centre to hip centre, as calibrated) from the hip centre, x to the player's right, y up, z towards the camera |
| `velocity[i]` | Body space per second |
| `offset`, `offsetVelocity` | The hip centre from where the player stood for calibration, in torso lengths: a step right is +x, a jump +y, a crouch −y |
| `capturedAt`, `ageMs` | When the newest pose's frame was captured (performance.now()), and how long ago |
| `aspect`, `torso`, `samples` | The picture's width over its height, the torso's share of its height, poses so far |
| `raw` | The newest pose as it arrived, for games that do their own geometry (below) |

Landmarks are MediaPipe's 33, by name in `JOINT` (`JOINT.rightWrist` is 16; `leftHand` and
`rightFoot` name the wrist and ankle). Body space reads the same for a child near the camera and
an adult at the back, so thresholds in torso lengths suit everyone. With the arms hanging, the
wrists are about ±0.5, 0; straight out to the sides ±1.36, 1; straight up about ±0.4, 1.9. The
head (nose) is at about 1.5.

**Latency and noise.** MediaPipe Lite gives 20–30 poses a second, 0.1–0.2 s after the movement
(the camera's own delay, which the browser can't see, then tracking, which `ageMs` counts), and
they jitter. Each landmark goes through a One Euro filter: steady while still, barely lagging while
moving fast. Values change only when a pose arrives, and are never predicted ahead. A landmark the
model is unsure of holds its last sure place for half a second, then follows the model's guess with
its confidence low. Feet are often out of the picture in a living room: don't depend on them, and
check `jointConfidence` before trusting a wrist. Design for slack: generous targets, effects a
beat behind the movement, nothing that needs a 50 ms reaction.

### Doing your own geometry: `raw` and `tracking`

`p.raw` is the newest pose exactly as the camera sent it, replaced (a new object) with each one
and null before the first: `landmarks` (the 33 in the unmirrored picture, 0–1, unfiltered, with
their confidences), `world`, `hands`, `input` (the picture's size, always unmirrored) and
`capturedAt`. Its picture is the camera's, not the mirror: the player's right hand is on its left.

A game with `tracking` in its definition (Table Tennis's first-person paddle) gets more in it,
for as long as its session lives (`PoseSource.setDetail`); the songs never ask for it. `'world'`
brings the world landmarks, and `'hands'` those and the hands. `'hands:right'` asks for only
every player's right hand, and `'hands:right/left'` for Player 1's right and Player 2's left
(`handsDetail(['right', 'left'])` in `packages/pose/webcamRecord.ts`; `'both'` for both). As a
function, `({ playerCount, options }) => 'hands' | 'world' | null` chooses per round, and a setting changed
mid-round (`ctx.setOption`) asks the camera again: Table Tennis asks for the hands with its
**Hand tracking** setting on (one player's both, two players' paddle hands), and for the world
landmarks otherwise.

- `world`: MediaPipe's 33 world landmarks, in metres from the hips' centre: x to the unmirrored
  picture's right, y down, z away from the camera. Their depths are the model's weakest output
  (flattened: a forearm pointing at the camera measures short there too); what holds up is the
  body's size across the picture, in metres, and which way a bone leans in depth, even when the
  model squashes how far (an elbow 15 cm behind the shoulder reads a few cm: Table Tennis's
  `arms.ts upperArmForward`). Null without the detail.
- `hands`: with one or two players, the Hand Landmarker's hands, found in a square cut round each
  of the pose's wrists (`TrackedHand` in `packages/pose/webcamRecord.ts`); with `'hands:…'`,
  only the ones asked for, each player's by where they stand (Player 1 furthest to the camera's
  right, as the mirror shows them on the left). Each Hand Landmarker needs a WebGL context, and Chrome keeps
  at most four in a worker, and the pose landmarkers can take two (`packages/pose/browser/hands.ts`): one
  player's two hands, or two players' one each, are each followed from frame to frame, but two
  players' both hands share a pair that looks afresh every frame, which costs about half again
  per hand and finds fewer. Ask for only the hands the game needs. A hand nearer the other
  person's wrist is left out. Each has `side` (the player's own
  hand, put on its side by the Hand Landmarker's handedness when the pose mixes up crossed
  wrists), 21 `landmarks` in the picture (unmirrored, z from the wrist, confidence null),
  21 `world` points in metres round the hand's middle, and `score` (how sure it is of the side).
  An empty list is no hand found; null is no Hand Landmarker running.

`ctx.handTracking()` says how the hands are doing: `'loading'` (the 7.8 MB model downloads the
first time it's asked for), `'on'`, `'dropped'` (a paired phone couldn't keep 15 poses a second with
it for 4 seconds, so it stood down and the world landmarks carry on; a webcam never drops them,
however slowly it tracks) or
`'unavailable'` (three or four players, a replay, a phone page too old for it, a model that
wouldn't load); null for a round
that didn't ask for the hands. Without hands, fall back on the pose's own wrist, index and pinky. Measure
latency from `raw.capturedAt`. The hand model costs a phone or slow laptop tracking time, so
only ask for it in a game that needs it, and consider letting players turn it off. A phone page
too old to know of `'world'` sends no world landmarks for it (`world` stays null). The puppet camera answers with world landmarks and
hands from its dolls' own 3D bodies (open hands, fingers on from the forearm); its arms are
shorter than a real body's (0.97 torso lengths, not about 1.1), which geometry that assumes real
proportions reads as reaching forward.

### Measures (`minigames/pose/gestures.ts`)

| Function | Gives |
| --- | --- |
| `handAt(p, side)`, `handVelocity`, `handSpeed` | A wrist in body space, its velocity, its speed across the picture |
| `bodyAt(p, joint)`, `screenAt`, `velocityAt`, `sureOf` | Any landmark by name; `sureOf` is confident and inside the picture |
| `armAngle(p, side)` | Degrees seen from the front: 0 hanging, 90 out to the side, 180 up, negative across the body |
| `elbowBend(p, side)` | 0 straight to about 180 folded |
| `armReach(p, side)` | The hand's distance from its shoulder as a share of the arm (about 1 stretched out) |
| `lean(p)` | Degrees the torso tilts, towards the player's right positive |
| `crouchDepth(p)`, `jumpHeight(p)` | 0–1 of a deep crouch (the hips 0.6 torso lengths down); the hips' height above standing |
| `handRaised(p, side)`, `handsRaised(p)` | A wrist above the nose; both |
| `handsApart(p)` | The wrists' distance across the picture, in torso lengths |

### Gestures

Detectors watch a player's poses and say when something happened. The host runs one of each,
with the defaults, for every player, and hands what they saw to the game in `frame.events` (only
while playing, each event once):

| `type` | When | Extra |
| --- | --- | --- |
| `jump`, `land` | The hips rise 0.18 torso lengths above standing, faster than 1 a second; back down past half that | `strength`: the rise's speed; landing: the height reached |
| `crouch`, `rise` | The hips drop 0.3 torso lengths; back up past half that | |
| `clap` | The hands meet (closer than 0.3) after closing faster than 1.2 a second; again once they've parted | |
| `swipe` | A hand moving faster than 3.6 a second mostly one way, 0.8 in one quick stroke | `hand`, `direction` on the screen (`left`, `right`, `up`, `down`) |
| `punch` | A bent arm straightening at the camera: its reach growing 0.3 within 0.35 s at 1.5 a second, out to 0.8 of its length, above the waist | `hand`, `direction: 'forward'` |
| `raise` | A hand held above the head for half a second | `hand` |

Each has `player`, `at` (the frame's capture time) and `strength`. Gestures fire as soon as the
movement is clear (a swipe once the hand has gone far enough, not when it stops), a frame or two
after the camera saw it. Movements overlap: a jump's arms swing up fast enough to be swipes, and
a hand raised quickly is a swipe up; listen for the gestures a game is about. For other
thresholds make your own detector (`createSwipeDetector({ speed, distance })`,
`createPunchDetector({ forwardOnly: false })`, …) and feed it each pose that arrives:

```ts
const swipes = useRef(createSwipeDetector({ speed: 2.5 })).current;
const seen = useRef(-1);
useMinigameFrame((frame) => {
  const p = frame.players[0];
  if (p.samples === seen.current) return;   // only new poses
  seen.current = p.samples;
  for (const e of swipes.update(p)) { /* … */ }
});
```

## Recording a session

Open `/?record=session`, choose **Experiments → Table Tennis**, pick the players and settings,
then **Play**. Where supported, Play asks once for a save folder before the round starts
tracking; later rounds reuse it until you reload. Start the webcam on the calibration card.
A small **REC m:ss** mark means capture is running. Pause and **Experiments**, reach results,
or hide the tab to finish; wait for the save confirmation before closing the page. Restart
finishes the old recording and starts a new one. A hidden tab ends its recording permanently;
start another round to record again. Only local webcam sources (including the puppet) record;
a paired phone or a pose replay cannot supply this browser's camera stream.

Stand in even light with the camera steady, far enough back that your head, shoulders, hips
and both hands stay in view throughout a swing. Leave room on both sides and avoid a bright
window behind you. Record 2–3 minutes solo and another 2–3 minutes with a second person, standing
side by side without overlapping. Try both paddle hands (change the setting between rounds),
forehands, backhands, reaches and quick returns. Include a little standing still and a few
misses. Keep the selected tracking settings with each recording so we can reproduce them.

Each round saves `aerodance-<game>-<yyyymmdd-hhmmss>.mp4` (H.264 when supported, otherwise
WebM/VP9 or the browser's supported fallback) and a matching `.jsonl`. Video is the native,
unmirrored camera stream at a requested 8 Mbps, with no audio or resizing. Nothing is uploaded.
Folder saving streams both files to disk; without the File System Access API, or if its picker
is cancelled, files accumulate in memory and two downloads finish the round (allow multiple
downloads). Prefer a folder-capable desktop browser for long recordings. Safari's codec and
background-tab behavior vary; check a short recording before collecting a long session. Closing
or crashing the browser during finalization can leave incomplete files.

Inspect a recording and extract video into trackbench's frame-folder layout (requires ffmpeg):

```sh
node tools/replay/cli.ts summary /path/to/session.jsonl
node tools/replay/cli.ts frames /path/to/session.mp4 /path/to/new-scene
```

A Table Tennis recording plays again through the game's own round, without a screen: every serve
and return with its swing, the ball's speed and how long it left the other player, or (`--hands`)
each stretch where a paddle hand went missing and why:

```sh
node tools/table-tennis/replay.ts /path/to/session.jsonl [--hands]
```

The log includes complete poses, hands/world landmarks when requested, camera-frame timestamps,
phase changes, changed `ctx.report` fields and tracking stats. Games can add small local events
with `ctx.record?.('paddle-contact', { player: 0 })` (absent without recording); Table Tennis
adds none yet. See [replay tools](../tools/replay/README.md) for the schema, clock alignment,
summary definitions and `readSession(path)`. `node apps/web/tests/session-recording.browser.ts`
tests the puppet flow and measures pose Hz with and without recording; evidence stays in `.cache/`.

## Testing with the puppet camera

`?input=puppet` makes the camera a **puppet camera**: up to four pretend people, posed from the
command line, drawn as paper dolls in the camera's picture and reported the way MediaPipe reports
people. Its frames go into the real `WebcamPoseSource` (`pose/puppet/puppetCamera.ts` supplies the
camera and a pose worker that answers each frame with the puppets instead of running the model),
so the player tracker numbers and follows them, calibration measures them, and the pose API and
gestures see them exactly as they'd see people. A game that works with the puppet works with a
person in front of a webcam, as far as the pose pipeline goes; it doesn't know what real bodies
do between poses, so try a real camera too before calling a game done.

By default as many puppets line up as the game has players (P1 on the left of the mirror), in
their own shirt colours, standing still. They're as real as a laptop webcam: each frame shows
them as they were 50 ms before the browser saw it and arrives 38 ms later (about 25 poses a
second), with a little jitter and the odd unsure hand or face point. `?puppets=2` places two
whatever the player count, and `?puppetRealism=clean|real|rough` picks how real (rough: a slow
machine in a dim room, missing people and joints now and then).

```sh
node scripts/play.ts start --url '/?input=puppet'
node scripts/play.ts click MINIGAMES
node scripts/play.ts wait minigameScreen=list minigameSelectReady=true
node scripts/play.ts click mgTile.0                    # Table Tennis
node scripts/play.ts wait minigameScreen=preview minigameSelectReady=true
node scripts/play.ts click MG_PLAY
node scripts/play.ts wait minigamePhase=calibrating minigameReady=true
node scripts/play.ts click GAME_CALIBRATION_PREVIEW    # Start camera: the puppets hold still
node scripts/play.ts wait minigamePhase=howto --timeout 20000
node scripts/play.ts puppet pose 0 rightUp             # P1 raises a hand to start (or click MG_HOWTO_START)
node scripts/play.ts wait minigamePhase=playing --timeout 8000
node scripts/play.ts puppet pose all stand
node scripts/play.ts puppet gesture 0 swipeLeft        # P1 swipes
node scripts/play.ts wait minigameGesture~0:swipe:left
node scripts/play.ts puppet play all tpose:400+300 armsUp:400+300 --loop
node scripts/play.ts shot --frame
node scripts/play.ts key Escape                        # pause; click GAME_RESUME, GAME_RESTART or GAME_QUIT
node scripts/play.ts click GAME_RESUME
node scripts/play.ts wait minigamePhase=playing --timeout 8000
node scripts/play.ts state                             # Table Tennis: mgScore, mgServer, mgPoint as the match goes
```

`node scripts/play.ts puppet <command>` runs a puppet command in the page (so does
`window.puppet.run('…')`; `window.puppet` is the `Puppet` itself). Who is a puppet's id, 0–3 (the
player it lines up as; `p1`–`p4` work too), or `all`. Points are body space, as in the pose API.

| Command | Does |
| --- | --- |
| `players <0-4\|auto>` | That many people in view, side by side; `auto` follows the game's player count again |
| `enter <who>`, `leave <who>` | Step into view where they last stood, or out of it |
| `pose <who> <name> [--ms 300] [--ease inOut]` | Tween to a named pose: `stand`, `tpose`, `armsUp`, `armsOut`, `vUp`, `leftUp`, `rightUp`, `leftOut`, `rightOut`, `armsForward`, `guard`, `punchLeft`, `punchRight`, `clap`, `hips`, `crouch`, `jump`, `leanLeft`, `leanRight`, `star`, `kickLeft`, `kickRight`, `kneeLeft`, `kneeRight`, `bow` |
| `set <who> <json>`, `to <who> <json> [--ms]` | Change the pose at once, or tween to it: `x`, `depth`, `lean`, `bow`, `turn`, `crouch`, `lift`, `headTilt`, `headTurn`, `leftHand`… (below) |
| `move <who> <x> [--ms 600]` | Walk across the mirrored picture (0 its left, 1 its right; beyond leaves it) |
| `hand <who> <left\|right> <x,y[,z]> [--ms]` | Put a hand at a body-space point; the arm follows (two-bone IK) |
| `joint <who> <joint> <x,y[,z]\|off> [--ms]` | Place any landmark (`nose`, `leftElbow`, …), or let it go |
| `gesture <who> <name> [--hand left\|right] [--speed 2]` | `swipeLeft`, `swipeRight`, `swipeUp`, `swipeDown`, `punch`, `clap`, `jump`, `squat`, `wave`, `flap`, `stepLeft`, `stepRight`, `leanLeft`, `leanRight` |
| `play <who> <step>... [--loop]` | Steps in turn, each `name[:ms[+hold]]` or `json[:ms[+hold]]`, e.g. `tpose:300+500 '{"lean":20}':300 stand` |
| `realism <clean\|real\|rough\|json>` | `jitter` (picture fractions), `dropout`, `jointDropout`, `captureMs`, `inferenceMs` |
| `reset` | Everyone standing still in place, realism back to real |
| `state` | Where everyone is |

A pose (`pose/puppet/rig.ts`) is `x` (the hips across the mirrored picture), `depth` (1 the usual
distance; 0.75 is close enough that the feet leave the picture, 1.3 farther), `lean` and
`headTilt` (degrees towards the player's right), `bow` (degrees towards the camera), `turn` and
`headTurn` (degrees to the player's right), `crouch` (0–1, feet planted), `lift` (torso lengths
off the floor), and `leftHand`, `rightHand`, `leftFoot`, `rightFoot` (body-space targets, the
feet measured as if standing). Changes go on a timeline from the moment they're asked for, so a
camera delay sees the past correctly; a new command cuts whatever was moving that puppet.

The puppet camera's frames come from the page like a webcam's (a canvas stream, one frame
tracked at a time), so a busy machine slows them as it would slow MediaPipe: if calibration
stalls or gestures go missing, `node scripts/play.ts status` shows the page's frame rate, and
`eval "minigame.source.view.message"` the poses a second. In development (and with
`?input=puppet`), `window.minigame` is the round's session: `eval "minigame.players[0].body[16]"`.

What to read back: `minigamePhase`, `minigameScores` (`3|5`), `minigameTimeMs`,
`minigameRemainingMs`, `minigameCountdown`, `minigamePresent` (`1|0`), `minigameGesture` (the last
gesture seen, `player:type[:direction][:hand]`), `minigameRaise` (the how-to card's raise to start,
0–1), `minigameCameraStatus`, `minigameHands` (`ctx.handTracking()`, for a round tracking
`'hands'`), `minigameCalibrationPlayers`, `minigameCalibrationProgress`, the
results' `minigameResults`, `minigameWinner` and `minigameNewBest`, the list's `minigameScreen`,
`minigameSelectReady`, `minigameList`, `minigameChosen`, `minigameDial`, `minigameOptions` (the
preview's settings, e.g. `mode=match|opponent=medium|…` for
Table Tennis), and the game's own `mg*` keys; a round's settings are
`eval "minigame.options"`. Table Tennis reports `mgMode` (`match`, `challenge`), `mgScore` (a match's
`3|5`, Player 1's or the player's first; Return Challenge's returns), `mgServer` (from 1; alone, 2 is
the robot), `mgPoint` (the last point: who won it and why, e.g. `2:out`; reasons in `match.ts`),
`mgBall` (`ready`, `serving`, `flying`, `between`), `mgTossed`, `mgDone`, `mgControls`, `mgSwing` (Easy: the
last swing's call and who made it, e.g. `1:early`), `mgRally`, `mgBest`,
`mgHits`, `mgReturns`, `mgAssist` and, with two, `mgHits1` and `mgHits2`; its HUD's `mgCall` (the last
point's call: `OUT`, `NET`, `SHORT`, `2 BOUNCES`, `MISSED`, `NICE!`, `GREAT RALLY!`, Return Challenge's
`+1`; with two, each view's, Player 1's first: `NICE!|MISSED`) and `mgBanner` (the banner showing:
`YOUR POINT`, `ROBOT'S POINT`, `POINT — PLAYER 2`, `DEUCE`, `MATCH POINT`, `GAME!`, `LEVEL 3`…, or none).
In development its D key shows the HUD's development panel (how the last ball went by each paddle,
the paddles' calibration, the settings and the keys), and its O and P
keys put a stand-in (`table-tennis/autoplay.ts`) in for the first and last player, which plays
through the real paddle and aim assist (`mgAutoplay` says who), so a match can run with puppets
standing still (the stand-ins serve too, tossing the ball and swinging through it; puppets
standing still never serve, and the match waits for them), and `window.tableTennis` has the round (`round`: its ball, players and settings)
and the camera (a split screen's views in `camera.cameras`) for staged shots. `?assist=off|low|normal|high`
sets its aim assist (Normal otherwise; the A key steps it, and the HUD says the new level for a moment). The puppet works for the song game too: its calibration and scoring
run on it.

### In unit tests

The puppet runs in Node: `apps/web/tests/minigame-pose.test.ts` pushes its frames through the
real player tracker, the webcam calibration and the pose followers on a fake clock (`rig()`), and
`apps/web/tests/minigames.test.ts` runs a whole round of `MinigameSession` that way. A game's
logic can be tested the same way: make a session with a puppet source, move the puppets, step the
clock and call `session.advance()`, and assert on `session.scores()` and what the game reported.

Table Tennis goes a step further: its round is plain code (`table-tennis/round.ts`, drawn by
`Game.tsx`), so pretend people of each skill, seen through a pretend webcam's delay and noise, play
whole rounds in milliseconds (`apps/web/tests/helpers/tableTennisSim.ts`).
`apps/web/tests/table-tennis-agency.test.ts` holds the game to what that shows (someone doing
nothing gets nothing, someone playing well nearly always hits, better players do better), and
`node tools/table-tennis/agency.ts [--controls easy,precise] [--assist off,low,normal,high]` prints the
whole table: run it before and after changing Easy's timing (`easy.ts EASY`), the aim assist, the
serve or how the paddle follows the hand.
`apps/web/tests/table-tennis-hud.test.ts` follows rounds through what the HUD says (`calls.ts`): each
point's call in each view, the banners and when they show, the prompts until they're known.

## Style

- **Aero.** Glass over a bright world: the dark glass panels and buttons (`drawDarkGlassPanel`,
  `drawGlassButton`), frosted where the world shows through (`useGlassBlur` for panes the game
  draws itself), white type with the navy drop shadow (`drawShadowText`, `drawCaps`), headlines in
  the wordmark's treatment (`drawHeadline`), soap bubbles, gel, sky, water, meadow. Players are
  blue, purple, green and pink (`PLAYERS` in `game/results.ts`; `DANCER_LOOKS` for characters),
  in that order. Rounded everything; no hard black outlines.
- **Readable on a TV across a room.** Text at least 20 design units, 26 or more for anything that
  matters mid-round; one idea per line; big targets.
- **Calm.** Wii-like: short celebrations, no flashing.
- **Fair to every player.** Mirror each player's world around where they stand; with three or
  four, nobody should need more room than a quarter of the picture.

## Performance

The game must hold 60 fps on an Apple TV 4K (3rd generation) in the Apple TV app, at the 640×480
buffer. A dance stage costs 60–130 draw calls and 0.2–0.8M triangles
([stages](../packages/stages/README.md)), and that's the budget for a whole minigame scene. Each
glass character is about 8 draw calls and 35k triangles.

- The game's overlay redraws every frame of the round and is uploaded as a 640×480 texture each
  time: keep its drawing cheap (no blurs or big gradients per frame; cache what doesn't change in
  an offscreen canvas).
- Don't allocate per frame in hot paths (the pose API updates in place); reuse vectors and arrays.
- Share materials and geometry; instance repeated things (`InstancedMesh`); avoid real-time
  shadows unless they matter (`MinigameWorld shadows`).
- Create materials up front, not mid-round, so no shader compiles during play.
- Check with the stats overlay (`?diag=stats`, or Settings → Graphics → Stats): `statsFps`,
  `statsDrawCalls`, `statsTriangles`, and on a real device.

## Checklists

Before starting a game:

- [ ] Its folder and `index.ts`, its `id` the folder's name; the icon drawn in `.ts`, the game
      behind `load`
- [ ] It plays with the player counts it says, and thresholds are in body space (torso lengths)
- [ ] With a split screen, the views and its draw calls are counted against the budget
- [ ] It moves only while `playing`, keeps score with `ctx`, and ends (`durationMs` or `ctx.finish`)

Before handing it in:

- [ ] `npm run lint`, `npm run typecheck` and `npm test` pass (the definition test included)
- [ ] With `node scripts/play.ts start --url '/?input=puppet'`: the whole flow from the main menu
      to the results and back, for each player count it supports, in 16:9 and 4:3
      (`resize 1024x768`), with screenshots looked at
- [ ] Its gestures fire from the puppet's (`minigameGesture`, `data-mg-*`), on `realism rough` too,
      and not while standing still
- [ ] Pause and resume mid-round (Escape and the pause icon), Restart, quit to Experiments
- [ ] Each setting does what it says, and its preview's rows fit in 16:9 and 4:3
- [ ] A new best shows on the results and on its preview
- [ ] 60 fps with `?diag=stats`, and draw calls and triangles within the budget
- [ ] Tried with a real camera, if there's one to hand

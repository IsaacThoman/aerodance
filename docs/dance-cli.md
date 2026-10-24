# Animating dancers with the `dance` CLI and Studio

`tools/dance` animates Aerodance dancers to a video by hand: you look at the video, key poses,
shape the motion between them, check it against the video, and export a song the game plays. It is
built so a coding agent can do all of it from a terminal, with a Studio for people (and for
checking an agent's work) on the same project files.

```sh
node tools/dance/cli.ts <command> <project> [options]    # or: npm run dance -- <command> …
node tools/dance/cli.ts help
```

It needs FFmpeg (`ffmpeg` and `ffprobe` on `PATH`) and Playwright's Chromium (`npx playwright install
chromium`) for previews and tracking. The project format is in [dance-format.md](dance-format.md).

## The workflow

This is how the 5-second phrase in the PR that added the tool was animated, from scratch, from a
video of one dancer.

1. **Create the project** from the video. Its audio becomes the song unless you give one.

   ```sh
   dance init ~/dances/dare --video dare.webm --dancers 1 --title Dare --artist Gorillaz
   dance attach ~/dances/dare --audio song.wav          # if the video has no (or the wrong) audio
   ```

2. **Survey the video** and pick the phrase. A single view wraps into a grid of frames.

   ```sh
   dance frames ~/dances/dare --range 4s:40s --every 1500 --views source --width 150
   ```

3. **Set the beat grid** so you can key on beats (`b21` is beat 21) and set the playable range.

   ```sh
   dance apply ~/dances/dare --op '{"op":"song","set":{"bpm":120,"beatOffsetMs":250,"playableStartMs":9750,"playableEndMs":15750}}'
   ```

4. **Read poses off the video.** Zoom on the dancer with `--grid`: labelled frame-coordinate lines
   (every 0.02 at this zoom) let you read each joint's position directly. Remember **the dancer's
   left is image right**; the overlay tags each wrist and ankle L or R.

   ```sh
   dance frames ~/dances/dare --at b21,b22 --views source --zoom 0.33,0.1,0.34,0.84 --grid --width 560
   ```

5. **Key the poses**, one op per beat with every control, in a patch file. Plant feet that stay put.

   ```json
   {"label": "block out the phrase", "ops": [
     {"op": "key", "dancer": "P1", "t": "b21", "set": {
       "head": [0.479, 0.308], "rightShoulder": [0.4455, 0.362], "leftShoulder": [0.522, 0.362],
       "rightElbow": [0.424, 0.453], "rightWrist": [0.409, 0.507], "leftElbow": [0.536, 0.437], "leftWrist": [0.544, 0.5],
       "rightHip": [0.467, 0.54], "leftHip": [0.515, 0.54], "rightKnee": [0.473, 0.723], "rightAnkle": [0.473, 0.842],
       "leftKnee": [0.517, 0.712], "leftAnkle": [0.51, 0.783]}},
     {"op": "contact", "dancer": "P1", "control": "rightAnkle", "start": "b21", "end": "b31"}
   ]}
   ```

   ```sh
   dance apply ~/dances/dare patch.json
   dance apply ~/dances/dare --op '{"op":"fit-body","dancer":"P1"}'    # body lengths from your poses
   ```

6. **Compare with the video between the keys**, every quarter beat. This is where timing problems
   show: in the proof the dancer held each pose for half a beat and snapped to the next, so smooth
   curves moved too early. Holds (`pose` from an earlier time) and a few in-between keys fixed it.

   ```sh
   dance frames ~/dances/dare --range b21:b31 --every 125 --views overlay --zoom 0.31,0.08,0.38,0.86 --width 230
   dance apply ~/dances/dare --op '{"op":"pose","dancer":"P1","t":"b22.5","from":{"t":"b22"}}'
   ```

7. **Check** for mistakes: jumps, stretched limbs (also drawn red on overlays), sliding feet, moves
   the character can't show. Each finding has a time range and an op to try.

   ```sh
   dance check ~/dances/dare
   ```

8. **Measure against the video.** `track` runs MediaPipe Lite over the video; `score` then plays the
   tracked dancer through the game's own scorer against your animation, and `compare` shows how many
   degrees each scored limb is off per half second, which points at the next fix.

   ```sh
   dance track ~/dances/dare --fps 30 --range 9.5s:16s
   dance score ~/dances/dare       # P1: 853,706 / 1,000,000, accuracy 85.4%, grade A, timing 2 ms
   dance compare ~/dances/dare --range b20:b31.5
   dance frames ~/dances/dare --range 13250:13625 --every 125 --views overlay --reference   # tracked pose dashed
   ```

   Tracking is evidence, not ground truth: in the proof, Lite reported raised arms as folded in
   front of the face, so the "worst" window there was the tracker's mistake. Look at the frames
   before changing keys to match it.

9. **Watch it move**, in-engine, and export.

   ```sh
   dance render ~/dances/dare --range b20:b31.5 --views overlay,character --out phrase.mp4
   dance frames ~/dances/dare --at b23,b27 --views stage           # the game's stage and mirrored coach
   dance export ~/dances/dare --install                            # into apps/web/public/songs (don't commit it)
   ```

   Then play it in the game, e.g. with the autoplay ghost:
   `node scripts/play.ts start --url '/?input=ghost'` (see [interactive testing](interactive-testing.md)).

To start from tracking instead of from scratch, `draft` turns the tracked video into editable keys
(simplified to the fewest keys within a tolerance) and fits the body: `dance apply <project> --op
'{"op":"draft","dancer":"P1"}'`. Then review and fix it as above.

## Commands

| Command | Does |
|---|---|
| `init <dir> [--video v] [--audio a] [--dancers 1-4] [--title t] [--artist a] [--link] [--no-proxy] [--no-video-audio] [--duration 30s]` | Creates a project. `--link` references the files where they are instead of copying them in. A video that may not play in a browser gets a VP9 proxy for the Studio. |
| `attach <dir> [--audio a] [--video v]` | Adds or replaces the song audio or the video |
| `show <dir>` | Song, sources, dancers, layers, key counts, contacts, phrases |
| `keys <dir> [--dancer P1] [--range a:b] [--controls c,…] [--layer id]` | The keys, with beats |
| `pose <dir> --at t [--dancer P1] [--landmarks]` | Every control's value (and optionally all 33 landmarks) at a time; lists elbows/knees placed automatically |
| `sample <dir> --range a:b [--every 100] --controls c,…` | Values over time, to check a trajectory |
| `apply <dir> [patch.json \| -] [--op '{…}']… [--expect-revision n] [--op-id id] [--label text] [--dry-run]` | Applies ops atomically; prints what changed |
| `undo <dir>`, `redo <dir>` | Steps through the history |
| `log <dir>` | The undo and redo history |
| `frames <dir> (--at t,… \| --range a:b [--every 250])` | A contact sheet PNG; see [Looking](#looking) |
| `render <dir> --range a:b [--fps 30] [--views …] [--no-audio] [--out clip.mp4]` | A preview clip with the song audio |
| `track <dir> [--fps 15] [--range a:b] [--no-strips]` | Tracks the video's dancers with MediaPipe Lite into a new tracking source. With several dancers, each gets a strip of the picture centred on its `home` (set homes first), as the game does for three and four players: the whole-picture search misses small or crowded people. Ops, checks and scores use the newest tracking that follows a dancer. |
| `check <dir> [--range a:b] [--dancer P1]` | Review findings; exits 1 if any is an error |
| `compare <dir> [--range a:b] [--every 500]` | Degrees between each scored limb and the tracked video, per window |
| `score <dir>` | The game's scorer with the tracked video as the player, over the tracked span |
| `export <dir> [--out song.zip] [--install] [--folder dir]` | The song bundle ZIP (default under `.dance/exports/`); `--install` writes it into the game's songs, replacing what this project installed last. The song id comes from the audio and the motion, so it stays the same while only details change. |
| `studio <dir> [--port 5310] [--dist] [--open]` | The Studio; while it runs, `frames` and `render` use its browser and return in about a second |

Every command takes `--json` for machine-readable output. Times are `4200` (ms), `4.2s`, `1:02.5`
or `b17` (beat 17, needing the song's bpm); ranges are `a:b` or `a..b`.

## Editing

Every edit is an op (`ops.ts`). `apply` takes a JSON array of ops, an object `{ "ops": [...],
"expectRevision"?, "opId"?, "label"? }`, a single op, or `--op` flags. A batch applies atomically:
every op succeeds and the result validates, or nothing changes, and the error names the op. The
reply says what changed, e.g. `revision 3 → 4: 6 ops, keys +94 ~0 -0, dancers P1, 11.000s (b22.5)–15.000s (b30.5)`.

- `--expect-revision n` refuses to apply (exit code 3) if someone else changed the dance since you
  read revision `n`. The Studio applies its own edits this way.
- Edits wait their turn: while another process is changing the project (a long `draft`, say) an
  `apply` waits for up to a minute.
- `--op-id id` makes a retry safe: the same id with the same ops returns the first result without
  applying them again.
- `--dry-run` reports what would change without writing.

Values: a point is `[x, y]` or `[x, y, z]`; `{"x": …}` sets only the given components; `{"dx":
0.02}` moves it from where it is. An angle is a number of degrees, or `{"d": 15}` to change it.
`controls` take controls and groups; on an additive layer that keys a group (e.g. `body`), naming
the group selects that channel.

| Op | Fields | Does |
|---|---|---|
| `key` | `dancer`, `t`, `set: {control or group: value}`, `layer?`, `interp?`, `ease?`, `follow?` | Keys values at `t`. Groups move relatively; on the base layer they key the points they move directly. With `follow` (default) an elbow or knee keyed at `t` keeps its place along its limb when the limb's ends move, and a head keyed at `t` stays over the shoulders. |
| `pose` | `dancer`, `t`, `from?`, `controls?`, `mirror?`, `depth?` | Keys a whole pose at `t`: `current` (lock in what's shown; the default), `neutral`, `{"t": …, "dancer"?: …}` (hold or copy a pose; from another dancer it moves to this one's home), or `tracking`. `mirror`: `frame` or `self`. |
| `delete` | `dancer?`, `t` \| `times` \| `range`, `controls?`, `layer?` | Removes keys (all dancers without `dancer`) |
| `interp` | `dancer?`, `t` \| `times` \| `range`, `controls?`, `interp?`, `ease?` | Sets the curve shape of keys |
| `retime` | `range`, `shift?`, `scale?`, `pivot?`, `dancer?`, `controls?`, `replace?` | Moves keys in a range (and, for all controls, contacts and exclusions inside it); landing on another key is an error unless `replace` |
| `contact` | `dancer`, `control`, `start`, `end`, `blendMs?` (80), `position?`, `id?` | Plants an ankle or wrist |
| `uncontact` | `dancer`, `id` \| `control?` + `range?` | Removes contacts |
| `copy` | `from: {dancer, range}`, `to: {dancer, t}`, `mirror?`, `timeScale?`, `repeat?`, `controls?`, `contacts?`, `replace?`, `offset?` | Copies a phrase's base keys (and contacts), optionally mirrored, faster or slower, repeated; to another dancer it moves to that dancer's home unless mirrored about the frame. Additive layers stay with their dancer. |
| `mirror` | `dancer`, `range?`, `about?` (`self` or `frame`) | Mirrors keys in place, on every layer: left and right swap |
| `smooth` | `dancer`, `range?`, `controls?`, `windowMs?` (120) | Smooths key values; keys with `stop`/`sharp`/`hold` and contact boundaries stay |
| `simplify` | `dancer`, `range?`, `controls?`, `tolerance?` (0.004), `angleTolerance?` (3°) | Removes keys while the curve stays within tolerance; same keys stay |
| `draft` | `dancer`, `tracking?`, `slot?`, `range?`, `controls?`, `everyMs?` \| `tolerance?`, `depth?`, `fitBody?`, `smoothMs?` | Keys from the tracked video |
| `arc` | `dancer`, `control`, `from`, `to`, `via: [x, y]`, `at?` (0.5) | Keys a point between two times, so the path passes `via` |
| `nudge` | `dancer`, `t`, `set: {control or group: offset}`, `fadeMs?` (150), `layer?` (`fix`) | An additive correction that fades in and out around `t` |
| `layer` | `dancer`, `action` (`add`, `update`, `remove`), `id`, `label?`, `enabled?`, `weight?` | Additive layers |
| `dancer` | `action` (`add`, `update`, `remove`), `dancer?`, `id?`, `label?`, `timeOffsetMs?`, `home?`, `body?`, `calibration?` | Dancers and their timing and proportions |
| `fit-body` | `dancer`, `from?` (`tracking` or keys), `t?`, `range?`, `home?` | Measures `body` (and `home`) from the keyed poses or the tracking |
| `song` | `set: {title, artist, bpm, beatOffsetMs, playableStartMs, playableEndMs, stage, difficulty, …}` | Song details |
| `video` | `startMs?`, `rate?` | Where the video sits on the song clock |
| `tracking` | `id`, `dancers: [id or null, …]` | Which dancer each tracked slot follows |
| `exclude`, `include` | `dancer`, `start`, `end`, `reason`, `controls?`, `id?` / `dancer`, `id` | Unscored intervals |
| `phrase`, `marker` | `action?`, `id?`, `label`, `start`/`end` or `t`, `dancer?`, `kind?` | Named ranges and markers, shown in the Studio and exported as markers |

You can also edit `dance.json` by hand; `dance show` validates it, and the Studio picks up the
change. Keep `revision` as it is: the next `apply` builds on it.

## Looking

`frames` renders one PNG with a row per time and a cell per view (a single view wraps into a grid):

| View | Shows |
|---|---|
| `source` | The video frame (an exact FFmpeg grab at the song time) |
| `overlay` | The frame with every dancer's skeleton: scored limbs heavier, the dancer's left side lighter than the right, L/R tags on wrists and ankles, automatically placed elbows and knees as hollow rings, stretched limbs red |
| `skeleton` | The skeletons on a grid, ineligible (unscored) joints grey |
| `character` | The game's glass characters, as filmed (`--mirror` mirrors them like the game's coach) |
| `stage` | The song's stage with the game's camera, post-processing and mirrored coach |

Options: `--zoom body|P1|P1:hands|P1:feet|P1:head|P1:arms|P1:legs|x,y,w,h` (a crop, framed over the
requested times), `--grid` (labelled coordinates), `--reference` (the tracked pose, dashed),
`--ghosts` (the neighbouring keys, faint), `--trails [ms]` (the paths the head, hands and feet
take either side of each time; white is ahead), `--before <revision>` (an earlier revision's
skeletons, dashed grey, to see what an edit changed), `--dancer P1,P2` (only these), `--width px`
(cell width). At most 48 frames per sheet.

Contact sheets are the main way an agent sees its work: read them with an image tool. Use `render`
for rhythm: a clip shows sliding, late arrivals and floaty transitions that stills hide.

## The Studio

`dance studio <project>` serves the Studio at http://127.0.0.1:5310 (or the next free port). It
edits the same `dance.json` through the same ops, and picks up changes from the CLI as they're
made, so a person and an agent can work on one dance together.

- **Video**: the source with every skeleton over it. Drag a joint to key it at the playhead. Wheel
  zooms, dragging the background pans, double-click fits. Toggles show the tracked pose, the
  neighbouring keys, or only the selected dancer.
- **Characters / Game**: the glass characters straight from the curves (as filmed, or mirrored), or
  exactly what the game shows on the song's stage (recompiled a moment after each edit).
- **Timeline**: seconds, beats and bars, markers and phrases; a row per dancer with its keys,
  contacts and unscored spans; and a row per channel for the selected dancer. Click to seek (drag to
  scrub), click a key to select it (shift adds), drag keys to retime them, Delete removes them,
  double-click a channel row to key it there, ctrl/⌘-wheel zooms. Key shapes show the curve
  (diamond smooth, triangle linear, square hold) and colours the ease (green stop, orange sharp).
- **Animate**: the dancer's controls (with where they're keyed), exact values to type, the key's
  interpolation and ease, Key pose / Key from video, contacts and layers. **Song**: details, beat
  grid, stage, playable range, video alignment. **Review**: check, score, export or install.

Keys: Space plays, ←/→ steps a video frame, ⇧←/→ a beat, `,`/`.` jump between keys, K keys the whole
pose, ⌘Z/⇧⌘Z undo and redo, 1–4 pick a dancer, G toggles the game view, M mirrors.

To drive it from a script, `node scripts/play.ts start --dance <project>` opens it in a GPU-rendered
headless Chromium; `state` and `wait` read the `.studio` element's `data-*` (revision, time,
dancer, control, mode), `drag x,y x,y` drags, and `window.danceStudio.jointOnPage(dancer, control)` /
`window.danceTimeline.keyOnPage(dancer, channel, t)` give page positions.

## Tips for agents

- Key full poses on the beats first, then look between them every quarter beat. Dance moves often
  hold and snap; a `pose` op copying the pose half a beat later holds it.
- Key elbows and knees: the scorer compares upper arms, forearms, thighs and shins. Unkeyed ones bend
  plausibly but are guesses (`check` notes them).
- Plant feet that don't move with `contact`, rather than keying them still: it removes sliding and
  survives retiming.
- Body proportions matter for stretched-limb checks and automatic joints: `fit-body` after the first
  poses, again after adding more.
- `compare` says where; `frames --reference` shows why. Trust the video over the tracker.
- Use `--expect-revision` when a person might be editing in the Studio at the same time.

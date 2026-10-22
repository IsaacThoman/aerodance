# Three and four players

What can realistically go from two players to four, and how the game does it.

## Tracking four people with one webcam

The game tracks players with MediaPipe's PoseLandmarker (tasks-vision 1.1.0) in a worker,
with `numPoses` set to the player count. Nothing in MediaPipe caps it at two, but each
extra person costs something:

- **Speed.** PoseLandmarker runs its person detector on the whole frame, then the landmark
  model once per person it tracks, so inference grows about linearly with players. Four
  people cost roughly twice what two do; on slower machines or the CPU fallback that can
  drop below the 15 poses/s the game already warns about ("Slow tracking; close other
  apps": the game already tracks with Lite). (Not measured on real hardware yet; see below.)
- **Space.** Four dancers with arms out need about 4 m side by side. A typical webcam sees
  about 1.6 m of width per metre of distance, so the players stand about 2.5–3 m back, which
  is also where full bodies (feet included, which calibration needs) fit the frame. Three
  players need about 3 m of width and 2 m of distance. That fits a big living room, not a
  small one.
- **Size in frame.** At that distance each person is roughly 250–350 px tall in the 640x480
  camera frame. That is within what the landmark model handles, but confidence is lower
  than for one or two close players, so a player is dropped more often in poor light.
- **Overlap and identity.** MediaPipe returns poses in no stable order and can merge or
  drop people who overlap. The game never relied on its order: the players are numbered left
  to right in the mirrored preview (P1, P2, P3, P4) once they're all in view, and then each
  number follows its person ([player tracking](player-tracking.md)). Players packed closer
  together overlap more often, so with four there are more moments where a player is lost
  for a few frames.

**Verdict:** three players is comfortable. Four players should work with enough room, good
light and the Lite or Full model, with more frequent "Step back into view" drops than with
two, but that is not proven yet. Both are enabled.

### What was measured

There is no recording of four real people, so the tests draw copies of one MediaPipe
sample photo (a wide, arms-out warrior stance) side by side into a synthetic 640x480
camera, and real MediaPipe Lite tracks it (`apps/web/tests/webcam.browser.ts`, and
`node scripts/play.ts camera 3` to try it by hand):

| Shot | Result |
|------|--------|
| 2 copies, 320 px wide each (the existing duet test) | both tracked |
| 3 copies squeezed to 213 px lanes at full height | all three tracked on every check, GPU and CPU |
| 1 copy alone at 160x178 px (person about 105 px tall) | not found: too small for the detector |
| 4 copies in 160 px lanes, natural or squeezed | none, or one, tracked |
| 4 copies 213 px wide, overlapping their neighbours | one tracked |
| 4 copies in a 16:9 (852x480) frame, 213 px lanes | none tracked |

In the failing four-copy runs MediaPipe itself returned no poses, so the game's player
assignment wasn't throwing tracked players away. Two limits show up: a person needs to be
roughly 40% of the frame height or more for the detector to find them, and dancers whose
outstretched arms overlap are merged or dropped. Four of this photo's wide-stance copies
can't satisfy both in one 4:3 frame. Real players standing side by side with arms down are
narrower than this photo, so a real four-player game may do better, but that still needs a
test with four people in front of one webcam. Expect four players to need about 4 m of
width at 3–3.5 m from the camera, with players keeping their arms out of their neighbours'
way.

Later measurements on real footage of three and four dancers (portrait phone video, and the
same cropped to the dancers) agree: MediaPipe found about two people per frame on average,
however many were in view, and the Full and Heavy models found no more than Lite (they share
its person detector; only the landmark model differs) while Heavy took twice as long. So with
three or four players, each player is missed in a good share of frames, and the tracker's job
is mostly to keep each number on its person through those gaps
([player tracking](player-tracking.md)).

Speed wasn't measured meaningfully: the headless GPU session's pose rate swung between
about 1 and 20 poses/s with the stage's GPU load, for two players as much as for three or
four, so it says nothing about speed on a player's machine.

## Choreography: duets danced by up to four

Songs are recorded in Dance Studio as duets: every choreography has exactly two tracks,
and recording four people at once would need a new Studio capture flow and new content.
So three and four players dance the duet's two parts in turn:

| Player | Part danced          | Colour |
|--------|----------------------|--------|
| P1     | part 1 (track 0)     | blue `#078fff`   |
| P2     | part 2 (track 1)     | purple `#b86bff` |
| P3     | part 1 (track 0)     | green `#1fcf72`  |
| P4     | part 2 (track 1)     | pink `#ff5fb4`   |

`partOf(playerId)` in `packages/pose/choreography.ts` is the one place that decides this,
and `sampleSong` hands each player their part's pose, quality mask and score exclusions,
so the scorer, the stage's coach dancers and ghost replay all see one pose per player.

A song says which counts it supports in `supportedPlayerCounts`: `[1, 2]`, `[1, 2, 3]` or
`[1, 2, 3, 4]`, and Song Select lists only the songs that support the chosen count. Dance
Studio now publishes `[1, 2, 3, 4]`, and the demo song was republished (bundle revision 3)
with four.

## What changed with the player count

- `PlayerCount` is `1 | 2 | 3 | 4`; webcam records (including a paired phone's, sent
  through the pairing relay) carry up to four poses. Choreographies, takes, tracks and Studio
  captures stay duets.
- Webcam tracking asks MediaPipe for one more pose than there are players and follows each
  player ([player tracking](player-tracking.md)); the setup preview draws each player's
  skeleton in their colour with their number over their head. A paired phone's own preview
  labels them too.
- `?record` recordings (`.adpose` kind `recording`) have one slot per player, up to four;
  every other `.adpose` kind still has at most two ([pose binary format](pose-binary-format.md)).
- Calibration has every player hold still together, as before, with shorter status labels
  when the columns are narrow.
- The players screen's dial picks the count; the dancers on the menu's glass stage show
  it, arriving in a soap bubble and popping when they leave.
- The live characters and their scores sit in the top corners: P1 and P2 on the left and
  P3 and P4 on the right with four players (P1, P2 left and P3 right with three), so the
  order matches where people stand.
- The stage's coach dancers, the results dancers and the results scores show one dancer per
  player in that player's colour.

## Not done

- Native three- and four-part choreography (more than two tracks), and recording it in
  Dance Studio.
- A test with four real people in front of one webcam. The automated webcam test covers
  three tracked people; four is covered only by ghost replay and unit tests.

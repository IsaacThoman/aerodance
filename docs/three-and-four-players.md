# Three and four players

What can realistically go from two players to four, and how the game does it.

## Tracking four people with one webcam

The game tracks players with MediaPipe's PoseLandmarker (tasks-vision 1.1.0) in a worker:
on the whole picture asking for exactly one or two people, or with three or four players
one person in each strip of the picture ([player tracking](player-tracking.md)). Their
whole-picture fallback asks for one extra person.
Nothing in MediaPipe caps it at two, but each extra person costs something:

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
three or four players, each player was missed in a good share of frames. So three or four
players are now each looked for in their own strip of the picture, which found nearly everyone
(3.9 of 4 people per frame on the same footage) for up to about twice the inference
([player tracking](player-tracking.md)). A strip that follows somebody another strip has (or
nobody) has the others' people greyed out of its next frame, so players standing close
together in the middle of the picture are all found too; and while a player is missing, a strip
that keeps finding nobody takes over somebody it shares with a neighbour, so the neighbour looks
for them instead.

Speed wasn't measured meaningfully: the headless GPU session's pose rate swung between
about 1 and 20 poses/s with the stage's GPU load, for two players as much as for three or
four, so it says nothing about speed on a player's machine.

## Choreography: one to four dancers, and who dances which

A song's choreography has one to four dancers, a track each: `dancerCount` in `song.json`
(songs published without it are duets), checked against the choreography's tracks when the
bundle loads. Any number of players can dance any song. Each player dances one of its
dancers, and several players can dance the same one. Which player dances which dancer is the
**cast** (`Cast` in `packages/pose/choreography.ts`: a dancer per player).

Without a pick, players are cast by where they stand (`autoCast`). They're numbered left to
right as they stand, and the coaches face them in the same order, so with at least as many
dancers as players, player 1 dances dancer 1, player 2 dancer 2 and so on. With fewer dancers,
neighbours share: everyone dances a solo, and four players dance a duet in pairs.

| Players | 1 dancer   | 2 dancers  | 3 dancers  | 4 dancers  |
|---------|------------|------------|------------|------------|
| 1       | 1          | 1          | 1          | 1          |
| 2       | 1, 1       | 1, 2       | 1, 2       | 1, 2       |
| 3       | 1, 1, 1    | 1, 1, 2    | 1, 2, 3    | 1, 2, 3    |
| 4       | 1, 1, 1, 1 | 1, 1, 2, 2 | 1, 1, 2, 3 | 1, 2, 3, 4 |

Song Select's preview has **Dancers** beside **Dance!** (for songs of two or more dancers):
a column per player, each with a cutout of every dancer to pick from by pointer, or with
Left/Right on the column. Auto goes back to casting by where everyone stands. The picks last
while the players come back to the same song, and Play again keeps them.

`sampleSong` hands each player their dancer's pose, quality mask and score exclusions, so the
scorer, ghost replay and the stage see one pose per player whoever they dance. The stage
shows every dancer of the song: once for each player dancing them, in that player's colour
(so players sharing a dancer each have their own coach, side by side), or once in clear glass
when nobody is (`coachesFor` in `packages/stages/shared/routine.ts`). On the Dancers screen
the stage camera stops circling and faces them.

| Player | Colour           |
|--------|------------------|
| P1     | blue `#078fff`   |
| P2     | purple `#b86bff` |
| P3     | green `#1fcf72`  |
| P4     | pink `#ff5fb4`   |

Song Select's buttons show a white cutout of each dancer a song was recorded with, however
many are playing.

A song says which player counts it supports in `supportedPlayerCounts`: `[1, 2]`,
`[1, 2, 3]` or `[1, 2, 3, 4]`, and Song Select lists only the songs that support the chosen
count. Dance Studio publishes `[1, 2, 3, 4]`, and the demo song was republished (bundle
revision 3) with four.

## What changed with the player count

- `PlayerCount` is `1 | 2 | 3 | 4`; webcam records (including a paired phone's, sent
  through the pairing relay) carry up to four poses, as do choreographies, takes and Studio
  captures.
- Webcam tracking looks for each of three or four players in their own strip of the picture
  and follows each player ([player tracking](player-tracking.md)); the setup preview draws each
  player's skeleton in their colour with their number over their head. A paired phone's own
  preview labels them too.
- `?record` recordings (`.adpose` kind `recording`) have one slot per player, up to four, and
  choreographies one per dancer ([pose binary format](pose-binary-format.md)).
- Calibration has every player hold still together, as before, with shorter status labels
  when the columns are narrow. A player the model misses for a moment (up to 0.2 s) is still
  holding: with three or four, one is missed now and then, and restarting the hold each time
  meant it could take a long while, or never finish.
- The players screen's dial picks the count; the dancers on the menu's glass stage show
  it, arriving in a soap bubble and popping when they leave.
- The scores sit in the top corners: P1 and P2 on the left and P3 and P4 on the right with
  four players (P1, P2 left and P3 right with three), so the order matches where people
  stand. The mirror between them shows every player's character as a cutout in their
  colour, mirrored like the setup preview.
- The stage's coach dancers show every dancer of the song, each player's in their colour;
  the results dancers and the results scores show one dancer per player in that player's
  colour.

## Not done

- A test with four real people in front of one webcam. The automated webcam test covers
  three tracked people; four is covered only by ghost replay and unit tests.

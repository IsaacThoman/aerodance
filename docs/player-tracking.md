# Player tracking

How the webcam (or a paired phone's camera) turns people into players.

## The pipeline

1. `WebcamPoseSource` (`packages/pose/browser/WebcamPoseSource.ts`) sends each new camera
   frame (640x480 asked for) to the pose worker, one frame at a time.
2. The worker (`pose.worker.ts`) runs MediaPipe's PoseLandmarker in VIDEO mode and asks it for
   `numPoses` people: **one** for one player, and **one more than there are players** for two to
   four. It also samples each person's **looks** (`appearance.ts`): the colours of their clothes
   on the chest, the waist and the thighs, from a 128-pixel-wide copy of the frame.
3. `PlayerTracker` (`tracker.ts`) decides which person is which player and gives the record
   one pose per player found. Everything after it (calibration, the live characters, the scorer,
   recordings) sees players, not detections.

MediaPipe reports people in no stable order and often misses one for a few frames, so the
tracker doesn't trust its order. Earlier versions split the picture into a lane per player;
the tracker replaced them.

## How the tracker decides

- **Following.** Each result's people are given to the players all at once, in the cheapest
  way. A player seen in the last quarter-second takes the person where they were heading (their
  last place moved on by their recent speed): nobody farther away than 0.7 of a body size, nor
  half as big again or a third smaller (somebody farther back walking past), nor a bystander. A
  player missing for longer takes a person seen in two results near the place they were last
  seen, if that person is nearer it than any other player (a player gone for good, on whose
  place somebody else has stood since, doesn't count).
- **The line-up.** Each player has a place: where they last stood clear of everyone else. A
  choice that changes the players' left-to-right order, passing a player found now or the place
  of one seen in the last five seconds, costs extra, so it only happens when the players were
  followed through it frame by frame (and isn't counted for players their looks tell apart).
  Until everyone has been in view at once, numbers are provisional; the first time they all
  are, none overlapping another, they're numbered left to right (P1 on the left of the mirrored
  preview). That is during calibration, which needs everyone in view; after it, a number only
  moves to another person through the rules below.
- **Overlaps.** Players who come within 0.6 of a body size of each other (or one vanishes
  beside the other) are tangled: the model may merge or swap them there. When they're all found
  and apart again, they're told apart by their looks if those differ clearly, and otherwise put
  back in the order they stood in before, whichever way the model's results went through it.
- **Looks.** Once players' looks are known and differ clearly, they count when matching, and
  they put mistakes right: a player whose person has looked like another player (not merely
  less unlike them) for a few results becomes that player (both swap when each looks like the
  other), and a player whose person doesn't look like them while somebody else in view (not a
  bystander) does, for ten results running, takes that somebody instead. Players dressed alike are never told apart by looks; brightness
  counts for a quarter, since how much of a white shirt or a dark jacket shows changes as
  somebody dances. A player's looks are learnt from frames where they stand clear, only very
  slowly from a person who doesn't look like them (who may be somebody else), not at all while
  somebody new has their number, and afresh once the players are first numbered.
- **Extra people.** Nobody can push a player out of the model's results while there's room
  for one more person, and extra people are ignored while every player is found. Somebody seen
  in ten results beside every player just seen (not overlapping one, and nowhere near a missing
  player's place) is a bystander: they can't take a player's number until that player has been
  gone five seconds. When there are more new people than free numbers, the bigger ones (nearer
  the camera) come first. A player missing for a second and a half can be found again anywhere;
  until then their number is kept for them.
- **Giving numbers back.** For 30 seconds after somebody new takes a missing player's number
  (or the player takes it back somewhere else), somebody their size who has come into view
  since and stands still at that player's old place for eight results running, while whoever
  has the number is elsewhere and doesn't look more like them, gets it back. A bystander can
  never take a number by looks.
- **Ghosts.** The model sometimes reports one person twice. A result whose joints mostly fall
  on another's is dropped.

## One player and several

| | 1 player | 2 players | 3 players | 4 players |
|---|---|---|---|---|
| People asked for | 1 | 3 | 4 | 5 |
| A new person counts after | 1 result | 2 results | 2 results | 2 results |
| Numbered | at once | left to right, once all are in view | left to right, once all are in view | left to right, once all are in view |

With one player, MediaPipe keeps following one person by itself, and looking for a second
would make it search the whole picture every frame, about three times the work. The tracker
still holds the player through moments where the model loses them. With more players,
looking for one more person costs about 10–20% more inference.

## What it can't do

- Two people dressed alike who cross over while overlapping can't be told from two people who
  part where they came from: they're put back in their old order.
- Somebody in view before every player is (a bystander while players step in) can be numbered
  as a player. The preview labels everyone over their head, so they can step out.
- Four players still depend on MediaPipe finding four people in one frame
  ([three and four players](three-and-four-players.md)).

## Tests

`packages/pose/tests/tracker.test.ts` has a scenario for each rule above, each failing without
its rule: numbering shoulder to shoulder, walking onto a missing player's place, a passer-by
behind a missed player, a neighbour lurching toward a missing player's place, a newcomer beyond
another player, bystanders (kept out, taking a number after five seconds and giving it back,
dressed like a player), overlaps and merges with and without looks, swaps put right by looks,
ghosts, and the looks themselves. `apps/web/tests/webcam.browser.ts` tracks the fixture photo
for real.

# Player tracking

How the webcam (or a paired phone's camera) turns people into players.

## The pipeline

1. `WebcamPoseSource` (`packages/pose/browser/WebcamPoseSource.ts`) sends camera frames
   (640x480 at 30 fps asked for) to the pose worker, one at a time. A frame that comes while one
   is in flight waits, replacing an older one, and goes as soon as the result is in, so tracking
   keeps up with the camera whenever a frame takes less than a frame's time.
2. The worker (`pose.worker.ts`) runs MediaPipe's PoseLandmarker in VIDEO mode:
   - **One or two players:** on the whole picture, asking for exactly the selected number of
     people. Asking for an extra person keeps the detector searching every frame while only
     the players are present, which can repeatedly lose someone it was already following.
   - **Three or four players:** on a full-height strip of the picture per player, asking each
     for one person (`tiles.ts`). On the whole picture, MediaPipe found about two people per
     frame with three or four in view: its person detector sees the picture shrunk to a small
     square, and while it follows fewer people than asked for it searches every frame, and its
     searches knock out people it was following. In a strip it follows exactly one person and
     only searches when it loses them, which found nearly everyone (3.9 of 4 per frame on the
     same footage) for up to about twice the inference (measured from a tenth to nine
     tenths more, more with four players than three). The strips are evenly spread and cover
     the whole width, and stay put: moving them onto where the players stood lost a player for
     a minute in testing. A strip that follows one person never searches the rest of it, so
     who it looks for is steered by greying people out of its next frame (their head, torso
     and legs: enough for the model to lose them, while whoever their outstretched arms reach
     over stays in view):
     - a strip that follows somebody another strip has, or nobody, has the people the other
       strips have greyed out, so it looks for whoever else is in it. Without that, somebody
       standing between two people the strips overlap on was never looked for: with three
       dancers in the middle half of the picture, all three were found together in 6 of 333
       frames, and 242 with it;
     - while a player is missing, a strip that has looked for 15 results (half a second at 30
       a second) and found nobody new takes over somebody it shares with another strip (whose
       torso is well inside it), so that strip looks for whoever else is in it: the strip
       somebody is followed in can be the only one that sees a player beside them. If it finds
       nobody, it sees them again (whichever of the two sees them better follows them), and the
       two don't try again for 300 results (ten seconds at 30 a second).

     Somebody two strips both see counts once (unless their joints differ: one may stand partly behind the other; torsos in
     the same place are one person whatever the strips make of their arms); joints beyond a
     strip's cut edges are marked unsure.
     Without a GPU, if the strips can't be set up, or in the iPhone/iPad app (where each
     strip's extra landmarker, 160-215 MB measured in WebKit, about 100 MB of it in the process
     the game runs in, hasn't been tried against a device's memory limit), the whole
     picture is used. A paired phone's page, which runs nothing but the camera, uses strips;
     how fast a phone runs three or four of them hasn't been measured.

   With two or more players it also samples each person's **looks** (`appearance.ts`): the
   colours of their clothes on the chest, the waist and the thighs, from a 128-pixel-wide copy
   of the frame.
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
  seen, if that person is nearer it than any other player (a player gone five seconds, whose
  place another player now stands on, doesn't count).
- **The line-up.** Each player has a place: where they last stood clear of everyone else. A
  choice that changes the players' left-to-right order, passing a player found now or the place
  of one seen in the last five seconds, costs extra, so it only happens when the players were
  followed through it frame by frame (and isn't counted for players their looks tell apart).
  Until everyone has been in view at once, numbers are provisional, so there's no line-up and
  nobody is a bystander yet; the first time they all are, none overlapping another and each in
  view for ten results (a third of a second at 30 a second, so a glitch of the model's isn't
  numbered), they're numbered
  left to right (P1 on the left of the mirrored preview). That is during calibration, which
  needs everyone in view; after it, a number only moves to another person through the rules
  below.
- **Overlaps.** Players who come within 0.6 of a body size of each other (or one vanishes
  beside the other) are tangled: the model may merge or swap them there. When they're all found
  and apart again, they're told apart by their looks if those differ clearly, and otherwise put
  back in the order they stood in before, whichever way the model's results went through it.
- **Looks.** With two or more players, once their looks are known and differ clearly, they
  count when matching, and they put mistakes right: a player whose person has looked like
  another player (not merely less unlike them) for a few results becomes that player (both swap
  when each looks like the other), and a player whose person doesn't look like them, while
  somebody else in view has looked clearly more like them for ten results running, takes that
  somebody instead (never a bystander, unless they came into view since somebody new took the
  number: the player coming back). Players dressed alike are never told apart by looks;
  brightness counts for a quarter, since how much of a white shirt or a dark jacket shows
  changes as somebody dances. A player's looks are learnt from frames where they stand clear,
  only very slowly from a person who doesn't look like them (who may be somebody else), not at
  all while somebody new has their number, and afresh once the players are first numbered. One
  player doesn't use looks at all (nobody to tell them from, and they may come back changed).
- **Extra people.** With one or two players, a bystander can displace a player in the model's
  limited results. The whole-picture fallback for three or four players has room for one
  extra person; in strips, a strip whose player is out of sight may
  follow somebody else, who is then just another person for the tracker. Extra people are
  ignored while every player is found. Somebody seen
  in ten results beside every player just seen (not overlapping one, and nowhere near a missing
  player's place) is a bystander: they can't take a player's number until that player has been
  gone five seconds. When there are more new people than free numbers, the bigger ones (nearer
  the camera) come first. A player missing for a second and a half can be found again anywhere;
  until then their number is kept for them.
- **Giving numbers back.** For 30 seconds after somebody new takes a missing player's number
  (or the player takes it back somewhere else, unless their looks say it's them), somebody
  their size who has come into view since and stands still at that player's old place for
  eight results running (results the model misses them in aside), while whoever has the number
  is elsewhere and doesn't look more like them, gets it back.
- **Ghosts.** The model sometimes reports one person twice. A result whose joints mostly fall
  on another's is dropped, and so are a squashed one (a torso under 6% of the height of its head
  and legs; on real people it's about a third, and above a tenth even bending deep), which the
  model can make of what's left of somebody a strip was shown hidden, and a tiny one (under a
  third of their size) inside somebody.
- **Who was there before.** Each person in a result continues somebody seen lately (in the
  last second, or five for a bystander) near where they are, the closest pairs first by where
  they are and how big, so a glitch beside somebody, or somebody smaller passing behind them,
  doesn't take over how long they've been in view or whether they're a bystander.

## One player and several

| | 1 player | 2 players | 3 players | 4 players |
|---|---|---|---|---|
| People asked for | 1 | 2 | 1 in each of 3 strips | 1 in each of 4 strips |
| A new person counts after | 1 result | 2 results | 2 results | 2 results |
| Numbered | at once | left to right, once all are in view | left to right, once all are in view | left to right, once all are in view |

With one player, MediaPipe keeps following one person by itself, and looking for a second
would make it search the whole picture every frame, about three times the work. The tracker
still holds the player through moments where the model loses them. With two players, asking
for two people lets MediaPipe keep following both once found. Two strips can latch onto the
same person when the players stand in the middle, so two players use the whole picture.

## Camera settings

Measured on the same footage: a higher resolution than 640x480 finds nobody more (the person
detector shrinks the picture anyway) and costs a few milliseconds a frame; 60 fps tracks no
better than 30 (but tracking at 15 is worse, hence sending waiting frames at once); and a 4:3
picture, which a 16:9 camera crops to when asked for 640x480, makes people bigger for the
detector, which tracked two players clearly better than the full 16:9 picture. Of MediaPipe's
thresholds, only the tracking one changes anything: raising it to 0.6 separates more
side-by-side people on the whole picture, but tracked no better overall and costs more, and
strips make it moot.

## What it can't do

- Two people dressed alike who cross over while overlapping can't be told from two people who
  part where they came from: they're put back in their old order.
- Somebody in view before every player is (a bystander while players step in) can be numbered
  as a player, unless they're farther back than the players; so can somebody else in view
  while the model misses a player for a second and a half before then (one standing partly
  behind another, say). The preview labels everyone over their head, so they can step out.
- With players dressed alike, somebody who walks to a player's old place and lingers there,
  while that player is back somewhere else and missed by the model, can be given their number.
- With three or four players, a strip whose player is out of sight may latch onto somebody
  nobody else is following (a bystander, or something person-shaped in the background), and
  doesn't look for the player again while that somebody stays in it. (Greying out whoever the
  tracker doesn't count as a player found them in tests, but on real footage it also hid
  dancers the tracker had wrongly taken for bystanders, so it isn't done.) Arms reaching past a
  strip's edge (about 1 joint in 100 with four players side by side) are the model's guesses,
  often with full confidence, so they're marked unsure and count as untracked
  ([three and four players](three-and-four-players.md)).

## Tests

`packages/pose/tests/tracker.test.ts` has scenarios for the rules above: numbering shoulder to
shoulder; walking onto a missing player's place, or standing on a long-gone player's; a passer-by
behind a missed player; a neighbour lurching toward a missing player's place; a newcomer beyond
another player; the people in front numbered first; bystanders (kept out, missed for a moment,
taking a number after five seconds and giving it back, even when the player keeps being missed,
dressed like a player); passers-by and lingerers at a player's old place; overlaps and merges
with and without looks; swaps put right by looks, and clothes that change; one player coming
back changed; ghosts; glitches (not numbered with the players, nor making a bystander somebody
new); somebody smaller passing behind a player; and the looks themselves.
`packages/pose/tests/tiles.test.ts` covers the strips: mapping back, merging copies, and who each
strip is shown hidden, and hand-offs. `apps/web/tests/webcam.browser.ts` tracks the
fixture photo for real (and in strips, with `BROWSER_GPU=metal`).

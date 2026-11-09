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
     MediaPipe's person detector often finds only one of two people standing close together,
     and then never the other, so two players also get a **search**: a second landmarker that,
     while the first finds only one person, is shown the picture with that person hidden
     (their head, torso and legs) and follows whoever else is there. It costs a second
     inference only while somebody is missing. In trackbench's close-together scenes it tracked
     both players in 65-79% of frames instead of almost none, and, on the same scorer, cut the
     score lost to tracking from 40-59% to 20-35% ([trackbench
     report](../tools/trackbench/REPORT.md#two-players-close-together-a-search-for-the-missing-one)).
     Like the strips, it needs the GPU and an extra landmarker.
     One player gets a **zoom**: MediaPipe's person detector misses somebody small in the picture
     (a 120° webcam, or far away) and finds them in its middle, enlarged. So while nobody has
     been found for a second, every other frame shows the landmarker the middle three quarters
     instead; whichever view finds somebody is kept, the middle only while all of them fits well
     inside it (somebody too big for it is found again on the whole picture, where the middle
     would cut off their feet or hands; somebody small at its edge is followed there). Somebody
     the landmarker finds afresh in the middle counts only standing (enlarged, an empty room's
     sofa can look like somebody lying on it), unless the player was last seen going down
     (leaning more than 20°) near there in the last 3 s: a player can lie on the floor in their
     dance. Every two seconds on the middle, another
     landmarker glances at the whole picture afresh, and somebody it finds elsewhere (a player
     walking in, while the enlarged middle took a mannequin for somebody) brings the whole
     picture back; until then a mannequin in the middle of an empty room can be taken for the
     player, and a small player who drops to the floor faster than the camera sees them going
     down isn't found again until they stand. On a 120° webcam the player was found in 96% of
     frames instead of none. The glances'
     landmarker is made the first time the middle is kept, and its first glance takes about
     150 ms (once a session). It runs on the CPU too, where it's the only way to find somebody
     small.
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
     Without a GPU, or if the strips can't be set up, the whole picture is used. Every source
     uses strips, the search and the zoom alike: the iPhone/iPad app's camera and a paired
     phone's page as well as a browser. Each costs a landmarker, 85-160 MB (about 100 MB in the
     process the game runs in, measured in the iOS simulator), which trackbench found well worth
     it in the app ([report](../tools/trackbench/REPORT.md#the-iphoneipad-app-the-same-pipeline-as-a-browser));
     how a real device's memory limit and speed take three or four strips hasn't been measured.

   With two or more players it also samples each person's **looks** (`appearance.ts`): the
   colours of their clothes on the chest, the waist and the thighs, from a 128-pixel-wide copy
   of the frame.
3. `PlayerTracker` (`tracker.ts`) decides which person is which player and gives the record
   one pose per player found. Everything after it (calibration, the live characters, the scorer,
   recordings) sees players, not detections.

If the worker fails after it was tracking (a lost WebGL context, an exception on a frame), the
source starts a new one with the same settings and carries on: the session, the tracker and
the player count stay, so the players keep their numbers, and the frame in flight is lost.
Frames wait meanwhile, as for a frame in flight, and the camera shows as starting until the
first result. A worker that fails before it was ready (a model that won't load) fails the
camera, as does one that fails a fourth time within a minute (`WORKER_RESTARTS`), so a worker
that dies on every frame still ends in its error.

A minigame that does its own geometry can ask for more (`PoseSource.setDetail('hands')`, while
its session lasts; the songs never do). The source then tells its worker, once it's ready, to
keep MediaPipe's 3D world landmarks with each person (metres from the hips' centre), which the
tracker carries with that person's body to their player's pose. With one or two players
(`MAX_HAND_PEOPLE`, `hands.ts`), the worker also runs MediaPipe's Hand Landmarker (`hand_landmarker.task`, 7.8 MB, fetched the first time
it's asked for and checked like the pose model) on a 256-pixel square cut round each of the
pose's wrists, one landmarker per side so each follows its hand from frame to frame; the Hand
Landmarker's own handedness puts each hand on its side when the pose mixes up crossed wrists
(on unmirrored pictures its labels match the real hand about nine times in ten). The hands come
with the pose as `hands` (`TrackedHand`, `packages/pose/webcamRecord.ts`), and `view.hands` says
how they're doing. Without the detail, the worker does and says exactly what it did before.

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
  An already followed dancer can have one unsure shoulder or hip while their position and size
  still pass the motion check; the joint stays unsure for scoring. Acquiring a player needs all
  four torso joints. Position and clothing penalties rank eligible matches, but are bounded
  below the cost of leaving a player missing, so an old place or clothing sample cannot keep
  an otherwise eligible person untracked indefinitely.
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
  Each song's setup starts with fresh assignments, without restarting the camera or model.
  Setup retries the line-up after four seconds without a calibration hold, on webcams and
  paired phones. A progressing hold and the song itself keep their assignments.
- **Overlaps.** Players who come within 0.6 of a body size of each other (or one vanishes
  beside the other) are tangled: the model may merge or swap them there. When they're all found
  and apart again, they're told apart by their looks if those differ clearly; otherwise, if
  they were clearly different sizes when they met and are again now (one passed in front of
  the other, so the nearer stays the bigger), by their sizes; and otherwise put back in the
  order they stood in before, whichever way the model's results went through it.
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
  player's place or home) is a bystander: they can't take a player's number until that player
  has been gone five seconds. A player's **home** is
  where they last stood clear while going no faster than 1.5 body sizes a second for half a
  second: where they dance. Their place follows whoever they're followed as, and the model can
  slide from a player onto somebody walking past in front of them, taking the place along; the
  home stays, so the player is found again where they dance once the passer-by has gone. When there are more new people than free numbers, the bigger ones (nearer
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
| Numbered | once in view for 10 results | left to right, once all are in view for 10 results | left to right, once all are in view for 10 results | left to right, once all are in view for 10 results |

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

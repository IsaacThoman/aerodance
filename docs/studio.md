# aerodance studio

The Studio is where a song's dance is made. It is part of the game's site, at `/studio/`, and the
idea behind it is simple: **dance it, then fix it**. You record each part of the song with your
camera (or bring in a video of the dance), the recording stays as the motion, you correct only the
moments that are wrong, you dance it back through the game's own scorer to see how it plays, and
you add it to the game.

```sh
npm run dev          # the game at http://localhost:5173/, the Studio at http://localhost:5173/studio/
```

A deployed game serves the Studio from the same build, at the same address with `/studio/` added.
It needs a current Chrome, Edge, Firefox or Safari outside private browsing (it keeps projects in
the browser's private file storage), and a camera that can see you head to toe.

## Why it works this way

- **Recorded motion reads as dancing.** On the glass character, hand-keyed moves tend to look
  mechanical. A take of a person dancing keeps the small movements that make it look alive, so the
  Studio keeps takes as the motion and layers corrections on top of them.
- **The routine and its players share one tracker and one clock.** Recording uses the game's own
  camera tracking, and stamps every pose with the song position that was audible when the
  camera's picture was taken, exactly as the game stamps its players' poses. A routine recorded
  here is compared with players the same way it was captured, which is why there is no separate
  delay calibration step.
- **It lives beside the game.** The Studio and the game share an address, so **Add to the game**
  puts a finished song straight into the game's library in this browser, with no file to move.

## Your dances

The first screen lists the dances kept in this browser.

- **New dance** asks for the song's title, its artist and how many dancers it has (solo, duet,
  trio or a crew of four; you can change this later).
- **Open a saved dance** takes a ZIP: a dance saved from the Studio, a `dance` command-line
  project folder zipped, or a finished song file (`.aerodance-song.zip`), which opens as a dance
  you can edit. A song opened this way has its dance as one recording per dancer; the takes and
  edits it was first made from aren't in a song file.
- **Open a folder** (Chrome and Edge on a computer) keeps a dance in a folder you choose instead of
  in the browser. Its files are yours to back up, and the [`dance` command-line tool](dance-cli.md)
  or a coding agent can work in the same folder while the Studio has it open: the Studio shows
  their changes within a couple of seconds. The browser asks again before the Studio uses the
  folder in a later visit. Taking a folder off the list leaves the folder where it is.

Dances kept in the browser belong to this browser on this device. Clearing the site's data deletes
them, and a browser short of space may too. The line under the list offers to ask the browser to
keep them; the download button on each card saves the dance as a file, which is the only copy
that survives the browser.

An open dance moves through five stations, across the top. Each shows a tick when its part is
done, and Fix shows how many things are left to look at. Undo and redo (⌘Z, ⇧⌘Z) work everywhere
and say what they will undo. Space plays and pauses, and the arrow keys step a beat (a bar with
Shift). In the timeline, drag the ruler to move through the song, shift-drag it to select a
stretch, click a section to select it, and hold ctrl or ⌘ while scrolling to zoom.

## 1. Song

The music, its beat, its sections, who dances and where.

- **Music.** Choose (or drop in) the song: an **MP3 or OGG** file. The Studio listens for the
  beat and fills in the tempo. Turn **Click** on and play to check it lands on the beat. If it
  doesn't: type the tempo, halve or double it, or play the song and **Tap along** (the T key) on
  every beat. *Where the count starts* moves the bar lines so they fall on the "one".
- **Sections.** The parts you will record one at a time. They are found from the music (parts
  that sound alike get the same name); rename them, **Split here** at the playhead, or remove
  them. Removing a section never removes music or recordings.
- **Dancers.** How many coaches the song has. Any number of players can dance any song: each
  follows one of the coaches.
- **Stage.** Where the song is danced. Picking one shows it in the coach view.
- **About the song.** Title, artist, who made the choreography, the difficulty (a playtest can
  measure it), and the part players dance: to leave out an intro or an ending, select the part to
  keep in the timeline and choose **Use the selection**.

## 2. Record

Dance each section in front of the camera.

1. **Turn the camera on.** Stand where it sees you head to toe, with room to move. The picture
   never leaves the device: only your poses are kept. The coach view now shows you as the
   character; the corner shows the camera's picture with your skeleton over it.
2. Pick **which part**: click a section in the timeline (or record the whole song). With more than
   one dancer, pick who you are recording; *People in the shot* records several dancers at once.
3. Press **Record** (R). After the count-in (one or two bars) the part plays and you dance. With
   **Keep looping until I stop** on, it goes round again and each time through is kept as a take.
   Press R or Space to stop, or Escape to throw that run away.
4. The newest take goes into the dance. Press Space to watch it back.

**Takes** lists every take of the part, with how much of it the camera tracked; **Use this one**
swaps it in. Deleting a take that is in use removes it from the dance too.

**Repeat or follow** fills a part without dancing it again: *repeat an earlier part here* (a
chorus that comes back), or have one dancer *follow another*, mirrored if you like. These stay
linked: when the part they come from changes, so do they.

Clicking a part in a dancer's lane picks it: remove it, split it at the playhead, mirror it, or
nudge it a little earlier or later.

**From a video** brings in a video of the dance instead of using the camera. The video must be one
the browser can play (MP4 or WebM). The Studio tracks the dancers in it, places each as a
recording, and keeps the video as a reference under the Fix station's skeletons. *Starts this far
into the song* lines the video up with the music.

Recorded parts are saved with their first and last poses held a moment past each end, so that
parts recorded separately blend into each other instead of dropping to a standing pose where they
meet.

## 3. Fix

Go through what needs a look, and touch up poses.

**To look at** lists everything that needs a decision, in song order. Clicking one goes there.

| It says | What happened | What you can do |
|---|---|---|
| The camera lost the dancer | The recording has a hole | **Record this part again**, or **Leave unscored** |
| Nothing recorded here | A stretch of the song has no dance yet | Record it, repeat another part there, or **Leave unscored** |
| Not sure about the left arm (or another limb) | The tracker was unsure of it, so it isn't scored | **Looks right: score it**, fix the pose, or **Leave unscored** |
| A sudden jump | The tracker lost a joint for a moment | Drag it back in the pose editor, or record again |

Stretches where a recorded dancer has nothing to dance are unscored whether or not you decide
them: standing still isn't choreography. The list is there so nothing is left out by accident.

The **pose editor** (left of the coach) shows every dancer's skeleton at the playhead, over the
reference video if there is one. Drag a joint to move it at that moment: the change eases in and
out around it, and an elbow or knee follows its hand or foot. **Move the whole body** (or
shift-drag) moves everything together. **Mirror** flips the picture to match the coach; unmirrored
it is as filmed, with the dancer's left on the picture's right.

**This moment** works on the selected stretch, or a beat either side of the playhead: **Undo
touch-ups here**, **Keep a foot or hand planted** so it can't slide or drift, and **Leave
unscored**.

**How it reads** pushes a dancer's moves further for the glass character, which has no elbows or
knees and shows a move through its hands, feet, hips, lean, turn and head: reach, bounce, sway,
lean, turn, head and lift. **As danced** puts them back.

In the timeline, each dancer's lane shows its touch-ups, plants, unscored stretches and the things
still to look at. `,` and `.` step between them.

## 4. Playtest

Dance it like a player would.

Turn the camera on, choose **who to follow** and **what to dance** (the whole song, or the
selected part), and press **Start**. The song's own stage shows the coach, the game's scorer
judges you as it would in the game, and your attempt is kept with the dance.

- **How it went**: the grade, the judgements, whether you were early or late on average, how much
  of the time the camera saw you, and which limbs were furthest off.
- **Attempts**: everyone's attempts at this dancer. They are scored again against the dance as it
  is now, so after a fix you can see whether it helped without dancing it again.
- **Where points go**: stretches where attempts that went well overall still lost points, with
  the likely reason (the camera lost the player, the pose was off, or the timing was off).
  **Look at it in Fix**, or **Leave unscored**. It needs two decent attempts before it calls
  anything a pattern.
- The **Points** lane in the timeline shows each second from red to green.
- The measured difficulty can replace the one you guessed.

## 5. Share

**Ready?** checks the song over: the music is in, it has a title and an artist, how much of each
dancer's dance is scored, whether anything is left to look at, and whether it has been danced
since it last changed. Only the first two can stop you.

- **Add to the game** puts the song in the game's library in this browser: Song Select lists it
  under Custom. After changing the dance, **Update it** replaces that copy.
- **Send it to a TV or another device** uses the game's own transfer: on the other device open
  Settings → Songs → Transfer songs, type the code it shows here, and the game opens ready to
  send ([how transfers work](game-song-bundles.md#transfer-songs-between-devices)).
- **Save the song as a file** downloads the `.aerodance-song.zip` any copy of the game imports
  (Settings → Songs → Import song).
- **Keep your work** downloads the dance itself, recordings and all, to open again later or in
  another browser.

## How a dance is put together

- A **take** is one recording: poses from the camera in song time, or tracked from the video.
  Take files are never rewritten; what plays is a cleaned view of them (short gaps bridged,
  jitter smoothed).
- Each dancer's timeline holds **parts**: stretches of takes, and linked repeats or follows of
  other stretches. Where parts overlap, the later one covers the earlier and they blend across
  the overlap.
- **Touch-ups** sit on top: each moves a joint at one moment and eases away either side, so the
  recording underneath keeps its life.
- **Plants**, the **how it reads** factors, **unscored** stretches and **looks right** approvals
  apply on top of that.
- The song the game gets is all of it baked together: sampled poses for each dancer, with the
  joints and stretches that aren't scored marked.

The file format behind this is [`aerodance.dance`](dance-format.md), version 2.

## Working with the `dance` command-line tool

A dance kept in a folder (**Open a folder**) is a `dance` project: the same `dance.json`,
`sources/` and history. `dance show`, `check`, `frames`, `render`, `apply` and `export` work on it
while the Studio is open, and their edits appear in the Studio. Everything the Studio does is
made of the same edit operations the CLI applies ([the ops](dance-cli.md#editing)), including
`clip`, `fix`, `approve` and `take` for recorded motion. Recording and tracking happen in the
Studio; the CLI can't add a take from a camera.

## What isn't here yet

- Making a dance from nothing but keys, and posing the character directly (the *performance*
  clips), are still done with the [`dance` CLI](dance-cli.md); the Studio plays both but doesn't
  edit them.
- Music has to be MP3 or OGG; other formats aren't converted.
- There is no library of ready-made moves.
- Projects made in the older capture tool (`tools/choreography`) can't be opened; the song files
  it exports can.

## For developers

[`apps/web/src/studio/README.md`](../apps/web/src/studio/README.md) explains how the app is put
together and the rules its stations follow. To drive it from a script, see
[interactive testing](interactive-testing.md#driving-the-studio).

# Agent notes

## Running and driving aerodance

When you need to run, play, screenshot or interactively test the game or Dance Studio, use `node scripts/play.ts`. [docs/interactive-testing.md](docs/interactive-testing.md) is the full guide.

1. `node scripts/play.ts start` (add `--studio`, `--dance <project>`, `--dist`, `--url '/?input=ghost'` as needed). Check that the printed renderer is a GPU, not SwiftShader.
2. Drive it: `click <LAYOUT_TARGET>` (`node scripts/play.ts targets` lists them), `key Escape`, then `wait key=value ...` on the canvas's `data-*` state before the next step. Wait for `menuReady=true` / `songReady=true` after each screen change.
3. `shot --frame` and read the PNG to see the result; `state` and `logs` when something looks wrong.
4. `node scripts/play.ts stop` when done.

The game's UI is drawn on a canvas, so DOM locators don't work for it; use layout targets. Dance Studio is DOM, so use `click --locator`.

## aerodance studio

The Studio, where songs' dances are made, is part of the game's site at `/studio/`
([docs/studio.md](docs/studio.md); code and its rules in
[apps/web/src/studio/README.md](apps/web/src/studio/README.md)). Drive it with the same script:

1. `node scripts/play.ts start --url /studio/`. A session starts with an empty library.
2. It is DOM: `click --locator '<css or text=…>'`, `type`, `key`, and `upload '<file input selector>' <file>`
   to choose a file. `wait key=value` and `state` read the root element's `data-*` (`screen`, `station`,
   `revision`, `audio`, `takes`, `clips`, `issues`, `busy`, `error`).
3. In development the page has `window.studio`: `studio.session` (apply ops, read state), `studio.view`,
   `studio.library`, and `studio.demo()`, which records a stand-in performer's take so the later
   stations have something to work on. The fixture camera stands still dancers in front of it.

Every edit the Studio makes is ops through `packages/dance` (the `dance` CLI's engine): change the
engine there, and a station only in its own folder under `apps/web/src/studio/stations/`.

## Minigames

To build or change a minigame, read [docs/minigames.md](docs/minigames.md): a game is one folder,
`apps/web/src/minigames/<id>/`, found by the registry. Test it with the puppet camera:
`node scripts/play.ts start --url '/?input=puppet'`, then `node scripts/play.ts puppet <command>`
(`puppet help`) to pose the pretend players, which go through the real tracking pipeline.

## Animating dances

To animate dancers to a video, use the `dance` CLI (`node tools/dance/cli.ts`); [docs/dance-cli.md](docs/dance-cli.md) is the guide. Look with `frames` (contact sheets you read as images; `--grid` for coordinates), edit with `apply` (JSON ops), and review with `check`, `compare` and `score`. Keep dance projects and their footage outside the repository.

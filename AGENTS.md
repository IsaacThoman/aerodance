# Agent notes

## Running and driving aerodance

When you need to run, play, screenshot or interactively test the game or Dance Studio, use `node scripts/play.ts`. [docs/interactive-testing.md](docs/interactive-testing.md) is the full guide.

1. `node scripts/play.ts start` (add `--studio`, `--dance <project>`, `--dist`, `--url '/?input=ghost'` as needed). Check that the printed renderer is a GPU, not SwiftShader.
2. Drive it: `click <LAYOUT_TARGET>` (`node scripts/play.ts targets` lists them), `key Escape`, then `wait key=value ...` on the canvas's `data-*` state before the next step. Wait for `menuReady=true` / `songReady=true` after each screen change.
3. `shot --frame` and read the PNG to see the result; `state` and `logs` when something looks wrong.
4. `node scripts/play.ts stop` when done.

The game's UI is drawn on a canvas, so DOM locators don't work for it; use layout targets. Dance Studio is DOM, so use `click --locator`.

## Animating dances

To animate dancers to a video, use the `dance` CLI (`node tools/dance/cli.ts`); [docs/dance-cli.md](docs/dance-cli.md) is the guide. Look with `frames` (contact sheets you read as images; `--grid` for coordinates), edit with `apply` (JSON ops), and review with `check`, `compare` and `score`. Keep dance projects and their footage outside the repository.

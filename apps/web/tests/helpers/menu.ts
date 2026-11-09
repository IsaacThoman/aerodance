// The main menu's buttons as a build draws them: Settings sits below Minigames while the build
// lists any minigames (menu/layout.ts), so tests find it the way the page places it.
import { readdirSync, statSync } from 'node:fs';
import type { Page } from 'playwright';
import { menuLayout } from '../../src/menu/layout.ts';
import { listMinigames } from '../../src/minigames/definition.ts';

/** Whether the page's main menu has Minigames (the canvas reports data-menu-minigames). */
export const pageHasMinigames = (page: Page) =>
  page.evaluate(() => document.querySelector<HTMLCanvasElement>('.canvas-frame canvas')?.dataset.menuMinigames === 'true');

/** The main menu's Settings button on this page. */
export async function settingsButton(page: Page, width: number) {
  return menuLayout(width, true, await pageHasMinigames(page)).SETTINGS;
}

/**
 * Whether a production build lists any minigames, from the game folders' definitions as the
 * registry reads them (dev-only games left out): for tests that plan their taps or key presses
 * before the app is running.
 */
export async function shipsMinigames(): Promise<boolean> {
  const dir = new URL('../../src/minigames/', import.meta.url);
  const folders = readdirSync(dir).filter((name) => statSync(new URL(name, dir)).isDirectory() && name !== 'pose');
  const found = await Promise.all(folders.map(async (folder) => ({
    folder, def: (await import(new URL(`${folder}/index.ts`, dir).href) as { default: unknown }).default,
  })));
  return listMinigames(found, { dev: false }).length > 0;
}

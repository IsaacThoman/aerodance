/*
 * How much of Table Tennis is the player's doing: pretend people of each skill, seen by each
 * kind of camera, play the game's own round without a screen (apps/web/tests/helpers/tableTennisSim.ts),
 * and the tables say how they got on: matches (alone against the robot, and two against each
 * other), and alone, Return Challenge. Someone doing nothing should get nothing; someone playing
 * well should nearly always hit, and the better the player the better the numbers.
 *
 *   node tools/table-tennis/agency.ts [--seconds 120] [--rounds 6] [--assist default,off,low,normal,high]
 *
 * (`default`: the level the game starts each round at.)
 */

import { ASSIST_LEVELS } from '../../apps/web/src/minigames/table-tennis/assist.ts';
import type { AssistLevel } from '../../apps/web/src/minigames/table-tennis/assist.ts';
import { SKILLS, TRACKING, simulateMany } from '../../apps/web/tests/helpers/tableTennisSim.ts';
import type { SimResult } from '../../apps/web/tests/helpers/tableTennisSim.ts';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const seconds = Number(arg('seconds', '120')), rounds = Number(arg('rounds', '6'));
const levels = arg('assist', 'default').split(',').filter((l): l is AssistLevel | 'default' => l === 'default' || (ASSIST_LEVELS as readonly string[]).includes(l)).map((l) => (l === 'default' ? undefined : l));

const pct = (n: number, of: number) => (of ? `${Math.round((100 * n) / of)}%`.padStart(5) : '    –');
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const minutes = (seconds * rounds) / 60;

function row(name: string, r: SimResult, i = 0) {
  const waits = [...r.waits].sort((a, b) => a - b);
  const won = r.matches.filter((m) => m[i] > m[i === 0 ? 1 : 0]).length;
  const tail = r.runs.length ? `  runs ${r.runs.length} mean ${mean(r.runs).toFixed(1)}` : `  matches won ${won}/${r.matches.length}`;
  return `${name.padEnd(26)} came ${String(r.came[i]).padStart(4)}  hit ${pct(r.hits[i], r.came[i])}  of them fair ${pct(r.fair[i], r.hits[i])}  hits/min ${(r.hits[i] / minutes).toFixed(1).padStart(5)}  rally mean ${mean(r.rallies).toFixed(1).padStart(4)} best ${String(r.best).padStart(3)}  wait median ${(waits[Math.floor(waits.length / 2)] ?? 0).toFixed(1)}s${tail}`;
}

for (const assist of levels) {
  for (const trackingName of ['perfect', 'one'] as const) {
    const tracking = TRACKING[trackingName];
    console.log(`\n== One player against the robot · assist ${assist ?? 'default'} · camera ${trackingName} ==`);
    for (const [name, skill] of Object.entries(SKILLS)) console.log(row(name, simulateMany({ players: [{ skill, tracking }], seconds, assist }, rounds)));
    console.log(`\n== Return Challenge · assist ${assist ?? 'default'} · camera ${trackingName} ==`);
    for (const [name, skill] of Object.entries(SKILLS)) console.log(row(name, simulateMany({ players: [{ skill, tracking }], seconds, assist, mode: 'challenge' }, rounds)));
  }
  for (const trackingName of ['perfect', 'one', 'two', 'laptop'] as const) {
    const tracking = TRACKING[trackingName];
    console.log(`\n== Two players · assist ${assist ?? 'default'} · camera ${trackingName} ==`);
    for (const [name, skill] of Object.entries(SKILLS)) {
      const r = simulateMany({ players: [{ skill, tracking }, { skill, tracking }], seconds, assist }, rounds);
      console.log(`${row(`${name} v ${name}`, r)}  serves/min ${((r.serves[0] + r.serves[1]) / minutes).toFixed(1)}`);
    }
    // (Someone not playing at all would never serve, and the match would wait for them.)
    const mixed = simulateMany({ players: [{ skill: SKILLS.good, tracking }, { skill: SKILLS.novice, tracking }], seconds, assist }, rounds);
    console.log(`${row('good v novice (good)', mixed, 0)}\n${row('good v novice (novice)', mixed, 1)}`);
  }
}

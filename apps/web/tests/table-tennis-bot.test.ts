import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TABLE, firstBounce, v3 } from '../src/minigames/table-tennis/ball.ts';
import type { Ball, V3 } from '../src/minigames/table-tennis/ball.ts';
import { BOT, BOT_LEVELS, BOT_SHOTS, botShot, planReturn, reaches, botTarget } from '../src/minigames/table-tennis/bot.ts';

const ball = (pos: V3, vel: V3): Ball => ({ pos, vel, cooldown: 0 });

test('the bot meets a fair return after its bounce, within reach behind the far end', () => {
  // A return off the player's paddle that lands deep on the far half.
  const plan = planReturn(ball(v3(0.1, 1, 1.4), v3(-0.3, 2.2, -4)));
  assert.ok(plan, 'it plans to meet it');
  assert.ok(plan.at.z <= BOT.line + 0.01 || plan.at.y <= BOT.low + 0.01, `where it can (${plan.at.z.toFixed(2)}, ${plan.at.y.toFixed(2)})`);
  assert.ok(plan.at.y > TABLE.top && reaches(plan.at));
  assert.ok(plan.t > 0.3 && plan.t < 1.5, `in time (${plan.t.toFixed(2)} s)`);
});

test('the bot leaves a ball that is not a fair return', () => {
  assert.equal(planReturn(ball(v3(0, 0.95, 1.4), v3(0, 0.5, -7))), null, 'into the net');
  assert.equal(planReturn(ball(v3(0, 1, 1.4), v3(0, 2.5, -9))), null, 'long, off the end');
  assert.equal(planReturn(ball(v3(0, 1, -1.5), v3(0, 1, 4))), null, 'coming the other way');
});

test("the bot's shots land on the near half at every level, from wherever it meets the ball", () => {
  let seed = 1;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const froms = [v3(0, TABLE.top + 0.15, -1.2), v3(0.8, TABLE.top + 0.4, BOT.line), v3(-0.6, TABLE.top + 0.9, BOT.line - 0.2), v3(2.2, TABLE.top + 0.1, -1.1), v3(0.3, TABLE.top + 1.9, BOT.line)];
  for (const level of BOT_LEVELS) {
    for (const from of froms) {
      for (let i = 0; i < 4; i++) {
        const landed = firstBounce(ball({ ...from }, botShot(from, level, rand)));
        assert.ok(landed && landed.at.z > 0.2 && Math.abs(landed.at.x) < TABLE.halfWidth, `${level} from (${from.x}, ${from.y.toFixed(2)}, ${from.z.toFixed(2)}): ${landed ? `${landed.at.x.toFixed(2)}, ${landed.at.z.toFixed(2)}` : 'no bounce'}`);
      }
    }
  }
});

test("the harder the bot's level, the faster (down the table) and wider its shots", () => {
  const from = v3(0, TABLE.top + 0.3, BOT.line);
  const speed = (level: (typeof BOT_LEVELS)[number]) => { const v = botShot(from, level, () => 0.5); return Math.hypot(v.x, v.z); };
  assert.ok(speed('easy') < speed('medium') && speed('medium') < speed('hard'), `${speed('easy').toFixed(1)}, ${speed('medium').toFixed(1)}, ${speed('hard').toFixed(1)} m/s`);
  assert.ok(BOT_SHOTS.easy.aim.spread < BOT_SHOTS.medium.aim.spread && BOT_SHOTS.medium.aim.spread < BOT_SHOTS.hard.aim.spread);
});

test('returning everything, the bot plays long, wide and own-half misses, but not the net', () => {
  const long = ball(v3(0, 1, 1.4), v3(0, 2.5, -9));
  const wide = ball(v3(0.3, 1, 1.4), v3(1.2, 2.4, -6));
  const ownHalf = ball(v3(0, 1.0, 1.3), v3(0, -1, -4.5));
  for (const [name, b] of [['long', long], ['wide', wide], ['off their own half', ownHalf]] as const) {
    assert.equal(planReturn(b), null, `${name}: not a fair return`);
    const plan = planReturn(b, false, true);
    assert.ok(plan && plan.at.z < 0 && plan.at.y > TABLE.top - 0.05, `${name}: ${plan ? `${plan.at.x.toFixed(2)}, ${plan.at.y.toFixed(2)}, ${plan.at.z.toFixed(2)}` : 'left'}`);
  }
  assert.equal(planReturn(ball(v3(0, 0.95, 1.4), v3(0, 0.5, -7)), false, true), null, 'into the net');
  // Nor one wide by the net, dropping out of the arm's reach.
  assert.equal(planReturn(ball(v3(0.3, 1, 1.4), v3(2.2, 1.5, -4.5)), false, true), null, 'wide by the net');
  assert.equal(planReturn(ball(v3(0, 1, -1.5), v3(0, 1, 4)), false, true), null, 'coming the other way');
  // A fair return it still lets bounce first.
  const fair = planReturn(ball(v3(0.1, 1, 1.4), v3(-0.3, 2.2, -4)), false, true);
  assert.ok(fair && (fair.at.z <= BOT.line + 0.01 || fair.at.y <= BOT.low + 0.01) && fair.at.z < -TABLE.halfLength + 0.5);
});

test('the bot\'s easy shots and serves go to the forehand of the player\'s paddle hand', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const meanX = (hand: 'left' | 'right') => {
    let sum = 0;
    for (let i = 0; i < 200; i++) sum += botTarget('easy', rand, hand).x;
    return sum / 200;
  };
  assert.ok(meanX('right') > 0.1, 'a right-hander\'s forehand is to their right (+x)');
  assert.ok(meanX('left') < -0.1, 'a left-hander\'s to their left');
  // Medium and hard spread both ways whatever the hand.
  assert.equal(botTarget('medium', () => 0.5, 'left').x, botTarget('medium', () => 0.5, 'right').x);
});

import { v3 } from '../../minigames/table-tennis/ball.ts';
import type { Ball, V3 } from '../../minigames/table-tennis/ball.ts';
import { BOT, botTarget, planReturn, reachRoom } from '../../minigames/table-tennis/bot.ts';
import { mine, mineBall } from '../../minigames/table-tennis/rally.ts';
import { GAP, faceNormal, forehand, heading, strokeOffset } from '../../minigames/table-tennis/robot.ts';
import type { Blade } from './dancer.ts';
import { add, dist3, lerp, squareTo, unit } from './vec.ts';

/*
 * A Torven arm playing at the near end (Robot vs Robot): the minigame's bot (bot.ts, robot.ts)
 * as it plays at the far end, mirrored. It works in the bot's frame (rally.ts `mine` of its own:
 * the arm at −z), where bot.ts's sums hold: when the other arm's shot crosses the net it plans
 * where it meets it (planReturn), goes there, and draws back, swings through it and follows
 * through (strokeOffset), its face turned to where it's sending it. Its blade (own frame) is
 * handed to the round like any player's, which judges the hit.
 */

/** Its paddle's face between shots: to the net, tipped up a little. */
const IDLE_NORMAL = faceNormal(v3(0, 0, 1), 0.15);

export class ArmPlayer {
  readonly rand: () => number;
  blade: Blade;
  /** Where it meets the ball (the bot's frame) and when, once it's planned; the shot's heading and side. */
  pos: V3 = { ...BOT.home };
  plan: { at: V3; contactAt: number } | null = null;
  aim: V3 | null = null;
  dir: V3 = v3(0, 0, 1);
  fore = true;
  normal: V3 = { ...IDLE_NORMAL };
  offset: V3 = v3();
  hitAt = -Infinity;
  /** A ball is coming its way (the other end has hit it), not yet planned for. */
  private coming = false;

  constructor(rand: () => number) {
    this.rand = rand;
    this.blade = this.toBlade();
  }

  /** The other end has hit the ball: it plans for it once it's over the net. */
  incoming() { this.coming = true; this.plan = null; }

  update(now: number, dt: number, _seen: V3 | null, ownBall: Ball, _inPlay?: boolean) {
    const ball = mineBall(1, ownBall);
    // Over the net onto its half: where it'll meet it (it'll have bounced once there).
    if (this.coming && !this.plan && ball.pos.z < 0 && ball.vel.z < 0) {
      const plan = planReturn(ball, false, false);
      if (plan) {
        this.plan = { at: plan.at, contactAt: now + plan.t };
        this.aim = botTarget('medium', this.rand);
        this.dir = heading(plan.at, this.aim);
        this.fore = forehand(plan.at);
      }
      this.coming = false;
    }
    const plan = this.plan;
    if (plan && now >= plan.contactAt) { this.hitAt = plan.contactAt; this.plan = null; }
    const until = this.plan ? this.plan.contactAt - now : null;
    // There as it's met: as quick as it needs to be.
    const goal = this.plan?.at ?? BOT.home;
    const away = dist3(goal, this.pos);
    const speed = until !== null ? Math.max(BOT.speed, away / Math.max(until, dt)) : BOT.speed * 0.6;
    this.pos = lerp(this.pos, goal, Math.min(1, (speed * dt) / (away || 1)));
    const playing = until !== null || now - this.hitAt < 0.5;
    const face = playing ? faceNormal(this.dir) : IDLE_NORMAL;
    const kn = 1 - Math.exp(-12 * dt), ko = 1 - Math.exp(-30 * dt);
    this.normal = unit(lerp(this.normal, face, kn));
    this.offset = lerp(this.offset, strokeOffset(until, now - this.hitAt, this.dir, this.fore, reachRoom(this.pos)), ko);
    if (!playing) this.dir = lerp(this.dir, v3(0, 0, 1), kn);
    this.blade = this.toBlade();
  }

  /** The paddle (the bot's frame): its middle just behind where the ball meets it. */
  armPose(): { pos: V3; normal: V3 } {
    return { pos: add(add(this.pos, this.offset), this.normal, -GAP), normal: this.normal };
  }

  private toBlade(): Blade {
    const arm = this.armPose();
    const n = mine(1, arm.normal);
    return { c: mine(1, arm.pos), n, d: squareTo(v3(0, 1, 0), n) };
  }
}

import { REALISM } from './Puppet.ts';
import type { Puppet, PuppetRealism, PuppetTarget } from './Puppet.ts';
import { GESTURES, POSES, isEase, namedPose } from './poses.ts';
import type { PosePatch, PuppetStep } from './poses.ts';
import type { Vec3 } from './rig.ts';

/*
 * The puppet's command line: one syntax for `node scripts/play.ts puppet ...` and
 * `window.puppet.run('...')`. Who is a puppet's id (0-3, the player it lines up as; p1-p4 work
 * too) or all. Points are body space (rig.ts): torso lengths from the hips, x to the player's
 * right, y up, z towards the camera.
 */

export const PUPPET_USAGE = `puppet <command>, where who is 0-3 (or p1-p4) or all:
  players <0-4|auto>              people in view, side by side (auto: as many as the game's players)
  enter <who> | leave <who>       step into view where they last stood, or out of it
  pose <who> <name> [--ms 300]    tween to a named pose: ${Object.keys(POSES).join(', ')}
  set <who> <json>                change the pose at once, e.g. '{"lean":20,"crouch":0.5}'
  to <who> <json> [--ms 300]      tween to it
  move <who> <x> [--ms 600]       walk across the mirrored picture (0 left .. 1 right; beyond leaves it)
  hand <who> <left|right> <x,y[,z]> [--ms 300]
                                  put a hand at a body-space point (the arm follows)
  joint <who> <joint> <x,y[,z]|off> [--ms 300]
                                  place any landmark (leftWrist, nose, rightAnkle...), or let it go
  gesture <who> <name> [--hand left|right] [--speed 1]
                                  ${Object.keys(GESTURES).join(', ')}
  play <who> <step>... [--loop]   steps in turn: name[:ms[+hold]] or json[:ms[+hold]], e.g. tpose:300+500 stand:300
  realism <clean|real|rough|json> jitter, dropout, jointDropout, captureMs, inferenceMs
  reset                           everyone standing still in place, realism back to real
  state                           where everyone is`;

/** Splits a command line into words, keeping quoted strings and JSON objects whole. */
export function words(line: string): string[] {
  const out: string[] = [];
  let word = '', depth = 0, quote = '';
  for (const c of line.trim()) {
    if (quote) { if (c === quote) quote = ''; else word += c; continue; }
    if (c === '"' && depth > 0) { word += c; continue; }
    if ((c === '"' || c === "'") && depth === 0) { quote = c; continue; }
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') depth--;
    if (/\s/.test(c) && depth === 0) { if (word) out.push(word); word = ''; continue; }
    word += c;
  }
  if (word) out.push(word);
  return out;
}

function target(word: string | undefined): PuppetTarget {
  if (word === 'all') return 'all';
  const n = /^p([1-4])$/i.exec(word ?? '') ? Number(word!.slice(1)) - 1 : Number(word);
  if (!Number.isInteger(n) || n < 0 || n > 3) throw Error(`Who is 0-3, p1-p4 or all, not "${word ?? ''}"`);
  return n;
}
function point(word: string | undefined): Vec3 {
  const parts = (word ?? '').split(',').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((v) => !Number.isFinite(v))) throw Error(`A point is x,y or x,y,z, not "${word ?? ''}"`);
  return { x: parts[0], y: parts[1], z: parts[2] ?? 0.05 };
}
function patch(word: string | undefined): PosePatch {
  try {
    const value: unknown = JSON.parse(word ?? '');
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as PosePatch;
  } catch { /* Said below. */ }
  throw Error(`Expected a JSON pose change like '{"lean":20}', not ${word ?? 'nothing'}`);
}
// One play step: name[:ms[+hold]] or json[:ms[+hold]].
function step(word: string): PuppetStep {
  const m = /^(.*?)(?::(\d+(?:\.\d+)?)(?:\+(\d+(?:\.\d+)?))?)?$/.exec(word);
  if (!m) throw Error(`Bad step "${word}"`);
  const [, body, ms = '300', hold = '0'] = m;
  return { patch: body.startsWith('{') ? patch(body) : namedPose(body), ms: Number(ms), hold: Number(hold) };
}

/** Runs one command line (or its words); returns the puppets' state, or the usage. */
export function runPuppetCommand(puppet: Puppet, input: string | readonly string[]): unknown {
  const args = typeof input === 'string' ? words(input) : [...input];
  const flags = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--loop') flags.set('loop', '1');
    else if (args[i].startsWith('--')) flags.set(args[i].slice(2), args[++i] ?? '');
    else rest.push(args[i]);
  }
  const [verb, ...a] = rest;
  const ms = flags.has('ms') ? Number(flags.get('ms')) : undefined;
  const easeName = flags.get('ease');
  if (easeName !== undefined && !isEase(easeName)) throw Error('--ease is linear, in, out or inOut');
  const tween = { ...(ms !== undefined ? { ms } : {}), ...(isEase(easeName) ? { ease: easeName } : {}) };
  switch (verb) {
    case undefined: case 'help': return PUPPET_USAGE;
    case 'state': return puppet.state();
    case 'players': {
      if (a[0] === 'auto') { puppet.auto = true; puppet.lineUp(puppet.requested); break; }
      const n = Number(a[0]);
      if (!Number.isInteger(n) || n < 0 || n > 4) throw Error('players takes 0-4 or auto');
      puppet.auto = false;
      puppet.lineUp(n);
      break;
    }
    case 'enter': puppet.auto = false; puppet.enter(target(a[0])); break;
    case 'leave': puppet.auto = false; puppet.leave(target(a[0])); break;
    case 'pose': puppet.pose(target(a[0]), a[1] ?? 'stand', tween); break;
    case 'set': puppet.set(target(a[0]), patch(a[1])); break;
    case 'to': puppet.to(target(a[0]), patch(a[1]), tween); break;
    case 'move': {
      const x = Number(a[1]);
      if (!Number.isFinite(x)) throw Error('move takes who and an x across the picture (0-1)');
      puppet.auto = false;
      puppet.move(target(a[0]), x, tween);
      break;
    }
    case 'hand': {
      if (a[1] !== 'left' && a[1] !== 'right') throw Error('hand takes who, left or right, and a point');
      puppet.joint(target(a[0]), `${a[1]}Wrist`, point(a[2]), tween);
      break;
    }
    case 'joint': puppet.joint(target(a[0]), a[1] ?? '', a[2] === 'off' ? null : point(a[2]), tween); break;
    case 'gesture': {
      const hand = flags.get('hand');
      if (hand !== undefined && hand !== 'left' && hand !== 'right') throw Error('--hand is left or right');
      puppet.gesture(target(a[0]), a[1] ?? '', { side: hand ?? 'right', speed: Number(flags.get('speed') ?? 1) || 1 });
      break;
    }
    case 'play': {
      const who = target(a[0]);
      if (!a[1]) throw Error('play takes who and steps, e.g. play 0 tpose:300+500 stand:300');
      puppet.play(who, a.slice(1).map(step), { loop: flags.has('loop') });
      break;
    }
    case 'realism': case 'noise': {
      const preset = a[0] as keyof typeof REALISM;
      const next: Partial<PuppetRealism> = preset in REALISM ? REALISM[preset] : (patch(a[0]) as Partial<PuppetRealism>);
      Object.assign(puppet.realism, next);
      return puppet.realism;
    }
    case 'reset': puppet.reset(); break;
    default: throw Error(`Unknown puppet command "${verb}"\n\n${PUPPET_USAGE}`);
  }
  return puppet.state();
}

// Plain words for the Fix station: what each joint, each part of the body and each kind of
// finding (packages/dance/check.ts) is called, and what a finding means for the dance.
import { GROUPS, POINTS, expandControls, isPointControl } from '../../../../../../packages/dance/format.ts';
import type { Dance, PointControl } from '../../../../../../packages/dance/format.ts';
import type { Finding } from '../../core/findings.ts';
import { clock } from '../../core/format.ts';

export const JOINT_WORDS: Readonly<Record<PointControl, string>> = {
  head: 'head', leftShoulder: 'left shoulder', rightShoulder: 'right shoulder', leftElbow: 'left elbow', rightElbow: 'right elbow',
  leftWrist: 'left hand', rightWrist: 'right hand', leftHip: 'left hip', rightHip: 'right hip', leftKnee: 'left knee', rightKnee: 'right knee',
  leftAnkle: 'left foot', rightAnkle: 'right foot',
};
const PARTS: readonly { name: string; group: string; joints: readonly PointControl[] }[] = [
  { name: 'left arm', group: 'leftArm', joints: ['leftShoulder', 'leftElbow', 'leftWrist'] },
  { name: 'right arm', group: 'rightArm', joints: ['rightShoulder', 'rightElbow', 'rightWrist'] },
  { name: 'left leg', group: 'leftLeg', joints: ['leftHip', 'leftKnee', 'leftAnkle'] },
  { name: 'right leg', group: 'rightLeg', joints: ['rightHip', 'rightKnee', 'rightAnkle'] },
];
/** What a list of joints (as an unscored or approved stretch names them) covers: "left arm", "whole body". */
export function partWords(controls: readonly string[] | null): string {
  if (!controls) return 'whole body';
  let joints: string[];
  try { joints = expandControls(controls).filter(isPointControl); } catch { return 'part of the body'; }
  const has = new Set(joints);
  if (POINTS.every(p => has.has(p))) return 'whole body';
  const parts = PARTS.filter(p => p.joints.every(j => has.has(j)) || (GROUPS[p.group as keyof typeof GROUPS] as readonly string[]).every(j => has.has(j)));
  const rest = joints.filter(j => !parts.some(p => (p.joints as readonly string[]).includes(j)));
  const names = [...parts.map(p => p.name), ...rest.map(j => JOINT_WORDS[j as PointControl])];
  if (!names.length || names.length > 4) return 'part of the body';
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
const jointOf = (f: Finding) => f.control && isPointControl(f.control) ? JOINT_WORDS[f.control] : null;
const partOf = (f: Finding) => PARTS.find(p => p.group === f.control)?.name ?? null;

/** A finding's name in the list. */
export function findingTitle(f: Finding): string {
  switch (f.kind) {
    case 'tracking-lost': return 'The camera lost the dancer';
    case 'no-motion': return 'Nothing recorded here';
    case 'unsure-tracking': return `Not sure about the ${partOf(f) ?? 'pose'}`;
    case 'jump': return 'A sudden jump';
    case 'foot-slide': return 'A foot slides';
    case 'stretched-limb': return 'A limb looks too long';
    case 'missing-take': return 'A recording is missing';
    case 'no-keys': return 'Nothing danced yet';
    case 'auto-joint': return f.control?.endsWith('Knee') ? 'A knee bends by itself' : 'An elbow bends by itself';
    case 'end-on-limb': return 'A limb points at the camera';
    case 'character-limit': return 'A foot dips below the floor';
    case 'contact-pull': return 'A planted foot or hand is tugged';
    case 'video-mismatch': return 'Doesn\'t match the video';
    case 'left-right': return 'Left and right look swapped';
    default: return 'Something to check';
  }
}
/** The joint a finding is about, where its name doesn't already say. */
export const findingJoint = (f: Finding): string | null => f.kind === 'unsure-tracking' ? null : jointOf(f);
/** A finding that covers the whole part players dance, rather than a moment of it. */
export const wholeSong = (f: Finding, dance: Pick<Dance, 'song'>) => f.startMs <= dance.song.playableStartMs + 1 && f.endMs >= dance.song.playableEndMs - 1;
/** When a finding happens: "0:12.4", "0:12.4 – 0:13.9" or "the whole song". */
export function findingWhen(f: Finding, dance: Pick<Dance, 'song'>): string {
  if (wholeSong(f, dance)) return 'the whole song';
  return f.endMs - f.startMs < 100 ? clock(f.startMs) : `${clock(f.startMs)} – ${clock(f.endMs)}`;
}
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
/** The checker's own sentence with the project's names in place of its ids. */
function tidy(message: string, dance: Dance): string {
  let text = message.replace(/ \(clip [^)]*\)/g, '');
  for (const d of dance.dancers) text = text.replace(new RegExp(`\\b${escaped(d.id)}\\b`, 'g'), d.label);
  text = text.replace(/\b(?:left|right)(?:Shoulder|Elbow|Wrist|Hip|Knee|Ankle)\b/g, joint => JOINT_WORDS[joint as PointControl]);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
/** What a finding means and what can be done about it, in a sentence or two. */
export function findingStory(f: Finding, dance: Dance): string {
  const who = dance.dancers.find(d => d.id === f.dancer)?.label ?? 'The dancer', joint = jointOf(f) ?? 'joint';
  switch (f.kind) {
    case 'jump': return `${who}'s ${joint} jumps further here than anyone moves in a moment: most likely the tracker lost it. Drag it back into place, or record this part again.`;
    case 'foot-slide': return `${who}'s ${joint} slides along the floor here. If the foot stands still in the dance, plant it.`;
    case 'stretched-limb': return `The limb ending at ${who}'s ${joint} is longer here than a limb can be. Drag the ${joint} closer in.`;
    case 'missing-take': return `A recording ${who} dances couldn't be opened, so nothing plays where it was. Record that part again.`;
    case 'no-keys': return `${who} has no motion yet and stands still. Record this dancer to give them a dance.`;
    case 'auto-joint': return `${who}'s ${joint} was never posed, so it bends by itself. Players are scored on it: drag it to where it should be at the moments that matter.`;
    case 'end-on-limb': return `The limb ending at ${who}'s ${joint} points almost straight at the camera here, so players can't be scored on it well.`;
    case 'character-limit': return `${who}'s ${joint} goes below the floor here. The character's foot stops at the floor.`;
    case 'contact-pull': return `${who}'s planted ${joint} is pulled a long way to where it's held. Start the plant where the ${joint} lands.`;
    case 'video-mismatch': return `${who} points away from the video here. Compare the two and touch up the pose.`;
    case 'left-right': return `${who} matches the video better here with left and right swapped.`;
    default: return tidy(f.message, dance);
  }
}
/** A finding's identity across checks of the same dance. */
export const findingKey = (f: Finding) => `${f.kind}|${f.dancer ?? ''}|${f.control ?? ''}|${f.startMs}`;

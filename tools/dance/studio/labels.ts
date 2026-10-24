import type { Control } from '../format.ts';

/** What the Studio calls each control. */
export const CONTROL_LABELS: Record<Control, string> = {
  head: 'Head', leftShoulder: 'Left shoulder', rightShoulder: 'Right shoulder', leftElbow: 'Left elbow', rightElbow: 'Right elbow',
  leftWrist: 'Left hand', rightWrist: 'Right hand', leftHip: 'Left hip', rightHip: 'Right hip', leftKnee: 'Left knee', rightKnee: 'Right knee',
  leftAnkle: 'Left foot', rightAnkle: 'Right foot', turn: 'Body turn', headYaw: 'Head turn', headPitch: 'Head tilt up', headRoll: 'Head tilt side',
};
export const controlLabel = (c: Control) => CONTROL_LABELS[c];
/** A channel's name for display: a control's label, or a group's id. */
export const channelLabel = (name: string) => (CONTROL_LABELS as Record<string, string>)[name] ?? name;

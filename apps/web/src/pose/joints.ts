/*
 * MediaPipe Pose's 33 landmarks by name, in its order (packages/pose/choreography.ts JOINT_NAMES
 * has the same names for people): the minigames' pose API (minigames/pose/body.ts) and the puppet
 * (pose/puppet/) name joints this way. Left and right are the person's own.
 */

export const JOINTS = [
  'nose', 'leftEyeInner', 'leftEye', 'leftEyeOuter', 'rightEyeInner', 'rightEye', 'rightEyeOuter', 'leftEar', 'rightEar',
  'mouthLeft', 'mouthRight', 'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist',
  'leftPinky', 'rightPinky', 'leftIndex', 'rightIndex', 'leftThumb', 'rightThumb', 'leftHip', 'rightHip',
  'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle', 'leftHeel', 'rightHeel', 'leftFootIndex', 'rightFootIndex',
] as const;
export type JointName = typeof JOINTS[number];
export type Side = 'left' | 'right';

/** Each joint's landmark index, with hand and foot as other names for the wrist and ankle. */
export const JOINT_INDEX: Readonly<Record<string, number>> = {
  ...Object.fromEntries(JOINTS.map((name, i) => [name, i])),
  leftHand: 15, rightHand: 16, leftFoot: 27, rightFoot: 28,
};

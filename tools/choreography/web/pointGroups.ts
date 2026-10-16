export type PointGroupId = "head" | "leftHand" | "rightHand" | "hands" | "leftFoot" | "rightFoot" | "feet" | "body";
/** A point group, or "single" to move one joint. */
export type PointSelection = PointGroupId | "single";
export interface PointGroup { label: string; indices: number[]; }
export const POINT_GROUPS: Readonly<Record<PointGroupId, PointGroup>> = {
  head: { label: "Head", indices: Array.from({ length: 11 }, (_, i) => i) },
  leftHand: { label: "Left hand", indices: [15, 17, 19, 21] },
  rightHand: { label: "Right hand", indices: [16, 18, 20, 22] },
  hands: { label: "Both hands", indices: [15, 16, 17, 18, 19, 20, 21, 22] },
  leftFoot: { label: "Left foot", indices: [27, 29, 31] },
  rightFoot: { label: "Right foot", indices: [28, 30, 32] },
  feet: { label: "Both feet", indices: [27, 28, 29, 30, 31, 32] },
  body: {
    label: "Whole skeleton",
    indices: Array.from({ length: 33 }, (_, i) => i),
  },
};
export const isPointSelection = (value: string): value is PointSelection =>
  value === "single" || Object.hasOwn(POINT_GROUPS, value);
/** The joints a selection moves together; undefined for a single joint. */
export const groupIndices = (selection: PointSelection): number[] | undefined =>
  selection === "single" ? undefined : POINT_GROUPS[selection].indices;

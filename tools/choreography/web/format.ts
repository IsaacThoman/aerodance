import type { OperationType } from "../core.ts";

export const timeLabel = (ms: number) =>
  `${Math.floor(Math.max(0, ms) / 60000)
    .toString()
    .padStart(
      2,
      "0",
    )}:${((Math.max(0, ms) / 1000) % 60).toFixed(2).padStart(5, "0")}`;
export const OPERATION_NAMES: Readonly<Record<OperationType, string>> = {
  joint: "Joint keyframe",
  swap: "Swap tracks",
  mirror: "Mirror target",
  'mirror-track': "Mirror track to other player",
  'recalibrate-body': "Recalibrate body from frame",
  smooth: "Smooth coordinates",
  cleanup: "Clean up poses",
  repair: "Gap repair",
  exclude: "Score exclusion",
  approve: "Reference approval",
  overwrite: "Overwrite track",
  clear: "Delete track",
  offset: "Track offset",
  interpolate: "Interpolate missing intervals",
};

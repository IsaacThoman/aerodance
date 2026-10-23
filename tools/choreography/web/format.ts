import type { OperationType, TrackChange } from "../core.ts";
import { playerList } from "./players.ts";

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
  'mirror-track': "Mirror track to another player",
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
  dancers: "Number of dancers",
};
/** The tracks a history entry changed, as its list shows them. */
export function operationTracks(op: TrackChange): string {
  if (op.type === "dancers") return `${op.beforeTracks.length} → ${op.dancers} dancer${op.dancers === 1 ? "" : "s"}`;
  if (op.type === "swap") return op.withPlayerId === undefined || op.playerId === null ? "P1 ↔ P2" : `P${op.playerId + 1} ↔ P${op.withPlayerId + 1}`;
  if (op.type === "mirror-track") return `P${op.sourcePlayerId + 1} → P${op.playerId + 1}`;
  if (op.playerId !== null) return `P${op.playerId + 1}`;
  if ("playerIds" in op && op.playerIds && op.playerIds.length < op.beforeTracks.length) return playerList(op.playerIds);
  return op.beforeTracks.length === 2 ? "Both tracks" : "All tracks";
}

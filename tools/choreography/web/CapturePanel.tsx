import type { PoseSourceController } from "../../../packages/pose/browser/PoseSourceController.ts";
import WebcamControls from "./WebcamControls.tsx";
import { Dot } from "./ui.tsx";
import type { LiveCapture } from "./useLiveCapture.ts";
import type { StudioProject } from "./useStudioProject.ts";
import type { Workspace } from "./useWorkspace.ts";

export interface CapturePanelProps { source: PoseSourceController; live: LiveCapture; studio: StudioProject; workspace: Workspace; }

// Webcam setup, body calibration and recording a new take.
export default function CapturePanel({ source, live, studio, workspace }: CapturePanelProps) {
  const { busy, execute } = studio;
  const { connection, calibrationCounts, recalibrate } = live;
  const { recording, recordDelay, setRecordDelay } = workspace;
  return (
    <div className="capture">
      <div className="section-heading">
        Webcam{" "}
        <Dot color={connection.status === "connected" ? "green" : ""} />
      </div>
      <WebcamControls source={source} connection={connection} disabled={recording || busy} />
      <button
        disabled={recording || busy}
        onClick={() =>
          execute(async () => {
            if (
              ["connected", "connecting", "initializing"].includes(
                connection.status,
              )
            ) {
              source.disconnect();
              return;
            }
            await source.setPlayerCount(2);
            await source.connect();
          })
        }
      >
        {connection.status === "connected"
          ? "Disconnect"
          : ["connecting", "initializing"].includes(connection.status)
            ? "Cancel connection"
            : "Start camera"}
      </button>
      <p className="connection-status">
        {connection.status} ·{" "}
        {connection.message || "Two players, one camera"}
      </p>
      <div className="tracking">
        {[0, 1].map((id) => (
          <span key={id}>
            <Dot color={connection.snapshot?.poses.some((p) => p.playerId === id) ? "green" : ""} />
            P{id + 1}{" "}
            {connection.snapshot?.poses.some((p) => p.playerId === id)
              ? "detected"
              : "waiting"}
          </span>
        ))}
      </div>
      <div className="body-calibration">
        <button disabled={recording || busy || connection.status !== 'connected'}
          onClick={recalibrate}>Recalibrate body</button>
        <small role="status">{calibrationCounts.every(count => count >= 20)
          ? 'Body calibration ready · distance compensation on'
          : `Stand upright with feet visible · P1 ${calibrationCounts[0]}/20 · P2 ${calibrationCounts[1]}/20`}</small>
      </div>
      <label>
        Recording delay (seconds)
        <input
          aria-label="Recording delay (seconds)"
          type="number"
          min="0"
          max="60"
          step="1"
          value={recordDelay}
          disabled={recording || busy}
          onChange={(e) =>
            setRecordDelay(
              e.target.value === "" ? "" : Number(e.target.value),
            )
          }
        />
      </label>
    </div>
  );
}

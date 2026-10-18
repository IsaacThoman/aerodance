import type { PoseSourceController } from "../../../packages/pose/browser/PoseSourceController.ts";
import WebcamControls from "./WebcamControls.tsx";
import { Dot } from "./ui.tsx";
import type { LiveCapture } from "./useLiveCapture.ts";
import type { StudioProject } from "./useStudioProject.ts";
import type { Workspace } from "./useWorkspace.ts";
import { capturePlayers, detectionCount } from './captureMode.ts';
import type { CaptureMode } from './captureMode.ts';

export interface CapturePanelProps { source: PoseSourceController; live: LiveCapture; studio: StudioProject; workspace: Workspace; }

// Webcam setup, body calibration and recording a new take.
export default function CapturePanel({ source, live, studio, workspace }: CapturePanelProps) {
  const { busy, execute } = studio;
  const { connection, calibrationCounts, recalibrate, captureMode, setCaptureMode } = live;
  const players = capturePlayers(captureMode);
  const { recording, recordDelay, setRecordDelay } = workspace;
  return (
    <div className="capture">
      <div className="section-heading">
        Webcam{" "}
        <Dot color={connection.status === "connected" ? "green" : ""} />
      </div>
      <label>Players<select aria-label="Webcam players" value={captureMode} disabled={recording || busy}
        onChange={e => void execute(() => setCaptureMode(e.target.value as CaptureMode))}>
        <option value="both">Both players</option><option value="p1">P1 only</option><option value="p2">P2 only</option>
      </select></label>
      <WebcamControls source={source} connection={connection} captureMode={captureMode} disabled={recording || busy} />
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
            await source.setPlayerCount(detectionCount(captureMode));
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
        {connection.message || (captureMode === 'both' ? "Two players, one camera" : `P${players[0] + 1} · whole-frame tracking`)}
      </p>
      <div className="tracking">
        {players.map((id) => (
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
        <small role="status">{players.every(id => calibrationCounts[id] >= 20)
          ? 'Body calibration ready · distance compensation on'
          : `Stand upright with feet visible · ${players.map(id => `P${id + 1} ${calibrationCounts[id]}/20`).join(' · ')}`}</small>
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

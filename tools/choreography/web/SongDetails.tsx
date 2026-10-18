import { oneOf } from "../../../packages/pose/choreography.ts";
import { DEFAULT_STAGE, STAGE_LIST, isStageId } from "../../../packages/stages/catalog.ts";
import type { Difficulty, ProjectV2 } from "../core.ts";
import { timeLabel } from "./format.ts";
import type { StudioProject } from "./useStudioProject.ts";

export interface SongDetailsProps { project: ProjectV2; studio: StudioProject; recording: boolean; }
const TEXT_FIELDS = [
  ["title", "Song name"],
  ["artist", "Performing artist"],
  ["description", "Description"],
] as const;
const LIST_FIELDS = [
  ["songwriters", "Songwriters / composers"],
  ["choreographers", "Choreographers"],
  ["tags", "Tags"],
] as const;
const DIFFICULTIES: readonly Difficulty[] = ["easy", "normal", "hard"];
const RIGHTS = ["audio", "choreography"] as const;

// Song metadata, distribution rights and the alignment sign-off that export requires.
export default function SongDetails({ project, studio, recording }: SongDetailsProps) {
  const { busy, edit } = studio;
  return (
    <div className="song-fields">
      <div className="panel-title">SONG METADATA</div>
      {TEXT_FIELDS.map(([key, label]) => (
        <label key={key}>
          {label}
          <input
            aria-label={label}
            disabled={recording || busy}
            value={project.metadata[key] || ""}
            onChange={(e) =>
              edit((p) => {
                p.metadata[key] = e.target.value;
                return p;
              })
            }
          />
        </label>
      ))}
      <label>
        Song ID
        <input
          aria-label="Song ID"
          disabled={recording || busy}
          value={project.songId}
          onChange={(e) =>
            edit((p) => ({ ...p, songId: e.target.value }))
          }
        />
      </label>
      {LIST_FIELDS.map(([key, label]) => (
        <label key={key}>
          {label}
          <input
            disabled={recording || busy}
            aria-label={label}
            value={project.metadata[key].join(", ")}
            onChange={(e) =>
              edit((p) => {
                p.metadata[key] = e.target.value
                  .split(",")
                  .map((v) => v.trim());
                return p;
              })
            }
            onBlur={() =>
              edit((p) => {
                p.metadata[key] = p.metadata[key].filter(Boolean);
                return p;
              })
            }
          />
        </label>
      ))}
      <div className="two-cols">
        <label>
          BPM
          <input
            type="number"
            disabled={recording || busy}
            value={project.metadata.bpm ?? ""}
            onChange={(e) =>
              edit((p) => {
                p.metadata.bpm = e.target.value
                  ? Number(e.target.value)
                  : null;
                return p;
              })
            }
          />
        </label>
        <label>
          Difficulty
          <select
            disabled={recording || busy}
            value={project.metadata.difficulty}
            onChange={(e) => {
              const difficulty = e.target.value;
              if (oneOf(DIFFICULTIES, difficulty))
                edit((p) => {
                  p.metadata.difficulty = difficulty;
                  return p;
                });
            }}
          >
            <option>easy</option>
            <option>normal</option>
            <option>hard</option>
          </select>
        </label>
      </div>
      <label>
        Stage
        <select
          disabled={recording || busy}
          value={project.metadata.stage ?? DEFAULT_STAGE}
          onChange={(e) => {
            const stage = e.target.value;
            if (isStageId(stage))
              edit((p) => {
                p.metadata.stage = stage;
                return p;
              });
          }}
        >
          {STAGE_LIST.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.id} — {stage.subtitle}
            </option>
          ))}
        </select>
      </label>
      <div className="section-heading">DISTRIBUTION RIGHTS</div>
      {RIGHTS.map((k) => (
        <label key={k}>
          {k === "audio"
            ? "Music license / permission"
            : "Choreography license / permission"}
          <input
            disabled={recording || busy}
            aria-label={`${k} license`}
            value={project.metadata.rights[k].license}
            onChange={(e) =>
              edit((p) => {
                p.metadata.rights[k].license = e.target.value;
                return p;
              })
            }
          />
        </label>
      ))}
      <p className="muted small">
        Record the actual license or permission to distribute. “Unknown”
        blocks song export.
      </p>
      <label className="check alignment">
        <input
          type="checkbox"
          disabled={recording || busy}
          checked={project.alignmentReviewed}
          onChange={(e) =>
            edit((p) => ({ ...p, alignmentReviewed: e.target.checked }))
          }
        />
        I reviewed audio/pose alignment near the start and end.
      </label>
      <div className="metadata-note">
        {timeLabel(project.durationMs)} audio length
        <br />
        Playable {timeLabel(project.playableStartMs)}–
        {timeLabel(project.playableEndMs)}
      </div>
    </div>
  );
}

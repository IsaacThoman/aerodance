import { useState } from "react";
import { oneOf } from "../../../packages/pose/choreography.ts";
import { DEFAULT_STAGE, STAGE_LIST, isStageId } from "../../../packages/stages/catalog.ts";
import type { Difficulty, ProjectV3 } from "../core.ts";
import { timeLabel } from "./format.ts";
import type { StudioProject } from "./useStudioProject.ts";

export interface SongDetailsProps { project: ProjectV3; studio: StudioProject; recording: boolean; }
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
// Raw text stays local; parsed values are committed immediately for Save and autosave.
function ListField({ label, values, disabled, onChange }: {
  label: string; values: string[]; disabled: boolean; onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return <label>{label}<input aria-label={label} disabled={disabled}
    value={draft ?? values.join(", ")}
    onChange={e => {
      setDraft(e.target.value);
      onChange(e.target.value.split(",").map(v => v.trim()).filter(Boolean));
    }} onBlur={() => setDraft(null)} /></label>;
}

// Song details and audio alignment.
export default function SongDetails({ project, studio, recording }: SongDetailsProps) {
  const { busy, edit, updateMetadata } = studio;
  return (
    <div className="song-fields">
      {TEXT_FIELDS.map(([key, label]) => (
        <label key={key}>
          {label}
          <input
            aria-label={label}
            disabled={recording || busy}
            value={project.metadata[key] || ""}
            onChange={e => updateMetadata({ [key]: e.target.value })}
          />
        </label>
      ))}
      {LIST_FIELDS.map(([key, label]) => (
        <ListField key={`${project.projectId}-${key}`} label={label} values={project.metadata[key]}
          disabled={recording || busy} onChange={values => updateMetadata({ [key]: values })} />
      ))}
      <div className="two-cols">
        <label>
          BPM
          <input
            type="number"
            disabled={recording || busy}
            value={project.metadata.bpm ?? ""}
            min="1"
            onChange={e => updateMetadata({ bpm: e.target.value ? Number(e.target.value) : null })}
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
                updateMetadata({ difficulty });
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
          aria-label="Stage"
          disabled={recording || busy}
          value={project.metadata.stage ?? DEFAULT_STAGE}
          onChange={(e) => {
            const stage = e.target.value;
            if (isStageId(stage))
              updateMetadata({ stage });
          }}
        >
          {STAGE_LIST.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.id} — {stage.subtitle}
            </option>
          ))}
        </select>
      </label>
      <label className="check alignment">
        <input
          type="checkbox"
          disabled={recording || busy}
          checked={project.alignmentReviewed}
          onChange={(e) =>
            edit((p) => ({ ...p, alignmentReviewed: e.target.checked }))
          }
        />
        Audio/pose alignment reviewed
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

import { Component, Suspense, useEffect, useMemo, useRef } from "react";
import type { PointerEvent, ReactNode } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { PMREMGenerator } from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import Character from "../../../packages/character/Character.tsx";
import type { CharacterAppearance } from "../../../packages/character/Character.tsx";
import {
  CONNECTIONS,
  JOINT_NAMES,
} from "../../../packages/pose/choreography.ts";
import type { Landmark, Pose, TrackCalibration } from "../../../packages/pose/choreography.ts";
import type { PreviewMode } from "./useWorkspace.ts";
import { dancerColor, dancerTint } from "./players.ts";

/** A dancer to draw as a character: its calibration maps poses onto the rig. */
export interface PreviewTrack { playerId: number; calibration: TrackCalibration; }
export interface PreviewProps {
  snapshot: { poses: Pose[] };
  /** Unedited poses drawn faintly behind the skeleton. */
  raw: { poses: Pose[] } | null;
  tracks: readonly PreviewTrack[];
  /** How many places the dancers stand in, P1 to Pn (at least as many as tracks). */
  slots?: number;
  mode: PreviewMode;
  playerId: number;
  joint: number;
  selectedJoints?: readonly number[];
  onSelect: (playerId: number, joint: number) => void;
  /** A joint moved to `value`; `commit` is false while dragging. */
  onEdit: (playerId: number, joint: number, value: Landmark, commit: boolean) => void;
  readOnly?: boolean;
  readOnlyLabel?: string;
  /** Shows the camera frame mirrored, as dancers see themselves. */
  mirrored?: boolean;
  emptyMessage?: string;
  emptyHint?: string;
}
interface ActorProps { pose: Pose | undefined; calibration: TrackCalibration; id: number; slots: number; mirrored: boolean; live: boolean; }
// How far apart the characters stand: a duet's 3.6, closer for three or four.
const actorX = (id: number, slots: number) => -(id - (slots - 1) / 2) * (slots > 2 ? 2.4 : 3.6);
function Environment() {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    camera.lookAt(0, 1.5, 0);
    const gen = new PMREMGenerator(gl),
      room = new RoomEnvironment(),
      target = gen.fromScene(room, 0.04);
    scene.environment = target.texture;
    room.dispose();
    gen.dispose();
    return () => {
      scene.environment = null;
      target.dispose();
    };
  }, [gl, scene, camera]);
  return null;
}
function Actor({ pose, calibration, id, slots, mirrored, live }: ActorProps) {
  const invalidate = useThree((state) => state.invalidate);
  const poseRef = useRef<Pose | null>(null);
  poseRef.current = pose ?? null;
  useEffect(() => invalidate(), [pose, calibration, invalidate]);
  const appearance = useMemo(
    (): CharacterAppearance => ({
      color: dancerColor(id),
      gloss: 85,
      accessory: "None",
    }),
    [id],
  );
  return (
    <group
      position={[actorX(id, slots) * (mirrored ? -1 : 1), 0, 0]}
      scale={[mirrored ? -1 : 1, 1, 1]}
    >
      <Character
        poseRef={poseRef}
        calibration={calibration}
        appearance={appearance}
        live={live}
      />
    </group>
  );
}
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="preview-fallback">
        3D preview unavailable on this device. Use the skeleton view to edit
        poses.
      </div>
    ) : (
      this.props.children
    );
  }
}
export default function Preview({
  snapshot,
  raw,
  tracks,
  slots = 2,
  mode,
  playerId,
  joint,
  selectedJoints = [joint],
  onSelect,
  onEdit,
  readOnly = false,
  readOnlyLabel = "Live pose skeleton",
  mirrored = false,
  emptyMessage = "No pose at this time",
  emptyHint = "Import a take or start the webcam to start capturing.",
}: PreviewProps) {
  const svg = useRef<SVGSVGElement>(null);
  // Reflect the whole camera frame. The same involution converts pointer
  // coordinates back to source coordinates when editing the flipped preview.
  const viewX = (x: number) => (mirrored ? 1 - x : x);
  type JointEvent = PointerEvent<SVGCircleElement>;
  function drag(event: JointEvent, index: number, pose: Pose) {
    event.preventDefault();
    event.stopPropagation();
    onSelect(pose.playerId, index);
    if (readOnly) return;
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: JointEvent, index: number, pose: Pose) {
    if (readOnly) return;
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const r = svg.current?.getBoundingClientRect();
    if (!r) return;
    const x = viewX((event.clientX - r.left) / r.width),
      y = (event.clientY - r.top) / r.height;
    onEdit(pose.playerId, index, { ...pose.landmarks[index], x, y }, false);
  }
  function end(event: JointEvent, index: number, pose: Pose) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (readOnly) return;
    const r = svg.current?.getBoundingClientRect();
    if (!r) return;
    onEdit(
      pose.playerId,
      index,
      {
        ...pose.landmarks[index],
        x: viewX((event.clientX - r.left) / r.width),
        y: (event.clientY - r.top) / r.height,
      },
      true,
    );
  }
  return (
    <div className={`preview preview-${mode}`}>
      {mode !== "skeleton" && (
        <Boundary>
          <Canvas
            frameloop="demand"
            camera={{ position: [0, 3.1, 10.5], fov: 36 }}
            dpr={[1, 1.5]}
            gl={{ antialias: true }}
          >
            <color attach="background" args={["#183841"]} />
            <hemisphereLight
              intensity={1.8}
              args={["#dbffff", "#1d615d", 1.8]}
            />
            <directionalLight position={[-3, 6, 5]} intensity={3} />
            <Environment />
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.08, 0]}>
              <circleGeometry args={[5.5, 80]} />
              <meshPhysicalMaterial
                color="#4b8088"
                metalness={0.4}
                roughness={0.24}
              />
            </mesh>
            <gridHelper
              args={[12, 20, "#397885", "#27545f"]}
              position={[0, -0.07, 0]}
            />
            <Suspense fallback={null}>
              {tracks.map((t) => (
                <Actor
                  key={t.playerId}
                  id={t.playerId}
                  slots={Math.max(slots, t.playerId + 1)}
                  calibration={t.calibration}
                  mirrored={mirrored}
                  live={readOnly}
                  pose={snapshot.poses.find((p) => p.playerId === t.playerId)}
                />
              ))}
            </Suspense>
          </Canvas>
        </Boundary>
      )}
      {mode !== "characters" && (
        <svg
          ref={svg}
          className="skeleton"
          viewBox="0 0 1000 750"
          preserveAspectRatio="none"
          aria-label={readOnly ? readOnlyLabel : "Editable pose skeleton"}
        >
          <defs>
            <pattern
              id="grid"
              width="50"
              height="50"
              patternUnits="userSpaceOnUse"
            >
              <path
                d="M 50 0 L 0 0 0 50"
                fill="none"
                stroke="#c2f6ef"
                strokeOpacity=".06"
              />
            </pattern>
          </defs>
          <rect width="1000" height="750" fill="url(#grid)" />
          <line
            x1="500"
            x2="500"
            y1="0"
            y2="750"
            stroke="#8ec8ce"
            strokeOpacity=".25"
            strokeDasharray="6 10"
          />
          {(raw?.poses || []).map((p) => (
            <g key={p.playerId} className="original-pose">
              {CONNECTIONS.map(([a, b]) => (
                <line
                  key={`${a}-${b}`}
                  x1={viewX(p.landmarks[a].x) * 1000}
                  y1={p.landmarks[a].y * 750}
                  x2={viewX(p.landmarks[b].x) * 1000}
                  y2={p.landmarks[b].y * 750}
                  stroke="#f4ffff"
                  strokeOpacity=".18"
                  strokeWidth="2"
                />
              ))}
            </g>
          ))}
          {snapshot.poses.map((p) => (
            <g
              key={p.playerId}
              style={{ color: dancerTint(p.playerId) }}
            >
              {CONNECTIONS.map(([a, b]) => (
                <line
                  key={`${a}-${b}`}
                  x1={viewX(p.landmarks[a].x) * 1000}
                  y1={p.landmarks[a].y * 750}
                  x2={viewX(p.landmarks[b].x) * 1000}
                  y2={p.landmarks[b].y * 750}
                  stroke="currentColor"
                  strokeWidth="4"
                  strokeLinecap="round"
                />
              ))}
              {p.landmarks.map((v, i) => (
                <circle
                  key={i}
                  cx={viewX(v.x) * 1000}
                  cy={v.y * 750}
                  r={
                    playerId === p.playerId && selectedJoints.includes(i)
                      ? 10
                      : 6
                  }
                  fill={
                    playerId === p.playerId && selectedJoints.includes(i)
                      ? "#fff"
                      : "currentColor"
                  }
                  stroke="#173941"
                  strokeWidth="2"
                  className={readOnly ? "" : "joint"}
                  onPointerDown={(e) => drag(e, i, p)}
                  onPointerMove={(e) => move(e, i, p)}
                  onPointerUp={(e) => end(e, i, p)}
                >
                  <title>
                    {JOINT_NAMES[i]} · Player {p.playerId + 1}
                  </title>
                </circle>
              ))}
            </g>
          ))}
        </svg>
      )}
      <div
        className="stage-label"
        style={{ flexDirection: mirrored ? "row" : "row-reverse" }}
      >
        {Array.from({ length: Math.max(slots, ...tracks.map((t) => t.playerId + 1)) }, (_, id) => (
          <span key={id}>
            <i className="dot" style={{ background: dancerTint(id) }} />
            PLAYER {id + 1}
          </span>
        ))}
      </div>
      {!snapshot.poses.length && (
        <div className="empty-stage">
          {emptyMessage}
          <span>{emptyHint}</span>
        </div>
      )}
    </div>
  );
}

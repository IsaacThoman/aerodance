import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { validateWebcamRecord } from '../../packages/pose/webcamRecord.ts';
import type { SessionFrame, SessionHeader, SessionLine, SessionPose } from '../../packages/pose/sessionLog.ts';

export interface RecordedSession { header: SessionHeader; records: SessionLine[]; }
/** Reads in file order. Invalid/truncated files fail with a line number instead of silently skewing statistics. */
export async function readSession(path: string): Promise<RecordedSession> {
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const records: SessionLine[] = [];
  let number = 0, previous = -Infinity;
  try {
    for await (const text of lines) {
      number++;
      const line = JSON.parse(text) as SessionLine;
      if (!line || typeof line.type !== 'string' || !Number.isFinite(line.t) || line.t < previous) throw Error('Expected a timed record in order');
      if (!records.length) {
        const h = line as SessionHeader;
        if (h.type !== 'header' || h.format !== 'aerodance.session' || h.version !== 1 ||
          !Number.isInteger(h.playerCount) || h.playerCount < 1 || h.playerCount > 4 ||
          typeof h.game !== 'string' || !Number.isFinite(h.videoStartTime) || !Number.isFinite(h.timeOrigin)) throw Error('Expected an aerodance session v1 header');
      } else if (line.type === 'header') throw Error('Unexpected second header');
      if (line.type === 'pose') {
        const pose = line as SessionPose;
        validateWebcamRecord(pose.record);
        if (typeof pose.lined !== 'boolean' || !Number.isFinite(pose.captureBrowserTimeMs) || !Number.isFinite(pose.receivedBrowserTimeMs)) throw Error('Invalid pose timing');
      }
      if (line.type === 'frame') {
        const frame = line as SessionFrame;
        if (!Number.isFinite(frame.metadata?.mediaTime) || !Number.isFinite(frame.metadata?.presentedFrames)) throw Error('Invalid frame metadata');
      }
      records.push(line);
      previous = line.t;
    }
    if (!records.length) throw Error('Empty session');
    return { header: records[0] as SessionHeader, records };
  } catch (error) {
    throw Error(`${path}:${number}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally { lines.close(); input.destroy(); }
}

/** Linearly interpolated sample quantile (including both endpoints). No samples gives null. */
export function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), at = (sorted.length - 1) * q;
  const lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}
export function summarizeSession({ header, records }: RecordedSession) {
  const poses = records.filter((line): line is SessionPose => line.type === 'pose');
  const intervals = poses.slice(1).map((line, i) => line.t - poses[i].t);
  const latency = poses.map(line => line.receivedBrowserTimeMs - line.captureBrowserTimeMs);
  const handRates = Array.from({ length: header.playerCount }, (_, playerId) => {
    // Denominator includes missing players and loading/dropped hands: the fraction of pose
    // results in which this player's hand was usable. Unrequested hands are still reported.
    const rate = (side: 'left' | 'right') => {
      const found = poses.filter(line => line.record.poses.some(p => p.playerId === playerId && p.hands?.some(h => h.side === side))).length;
      return { found, samples: poses.length, rate: poses.length ? found / poses.length : null };
    };
    return { playerId, left: rate('left'), right: rate('right') };
  });
  // Include silence before the first result and after the last, not just gaps between results.
  const bounds = [header.t, ...poses.map(p => p.t), records.at(-1)?.t ?? header.t];
  const gaps = bounds.slice(1).flatMap((t, i) => t - bounds[i] > 200 ? [{ from: bounds[i], to: t, durationMs: t - bounds[i] }] : []);
  const span = poses.length > 1 ? poses.at(-1)!.t - poses[0].t : 0;
  return {
    durationMs: (records.at(-1)?.t ?? header.t) - header.videoStartTime,
    players: header.playerCount, poseCount: poses.length,
    poseHz: { mean: span > 0 ? (poses.length - 1) * 1000 / span : null,
      p5: quantile(intervals.filter(ms => ms > 0).map(ms => 1000 / ms), 0.05) },
    captureToResultMs: { median: quantile(latency, 0.5), p95: quantile(latency, 0.95) },
    handRates, gapsOver200Ms: gaps,
    frameCount: records.filter(line => line.type === 'frame').length,
  };
}

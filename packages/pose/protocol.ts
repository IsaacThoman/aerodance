// Pose wire records (protocol v2), the format of pose recordings and legacy captures, with a
// bounded NDJSON decoder.
import { finite, isArray, isObject, oneOf } from './choreography.ts';
import type { CaptureInput, PlayerCount, Pose } from './choreography.ts';

export type PipelineState = 'starting' | 'running' | 'error' | 'stopping';
export interface ProtocolPoseRecord {
  protocolVersion: 2; type: 'pose'; sessionId: string; seq: number;
  frameReceivedTimeMs: number; resultTimeMs: number; playerCount: PlayerCount; input: CaptureInput;
  /** Ascending playerIds below playerCount; an absent player is omitted. */
  poses: Pose[];
}
export interface ProtocolHeartbeat {
  protocolVersion: 2; type: 'heartbeat'; sessionId: string; producerTimeMs: number;
  lastPoseSeq: number | null; pipelineState: PipelineState;
}
export type ProtocolRecord = ProtocolPoseRecord | ProtocolHeartbeat;

export const MAX_BYTES = 16 * 1024;
const states: readonly PipelineState[] = ['starting', 'running', 'error', 'stopping'];
const integer = (n: unknown, min = 0): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min;
const score = (n: unknown) => n === null || (finite(n) && n >= 0 && n <= 1);
export function assertProtocolRecord(record: unknown): asserts record is ProtocolRecord {
  if (!isObject(record) || record.protocolVersion !== 2 || typeof record.sessionId !== 'string' || !record.sessionId.trim()) throw Error('Invalid protocol/session');
  if (record.type === 'heartbeat') {
    if (!integer(record.producerTimeMs) || !(record.lastPoseSeq === null || integer(record.lastPoseSeq, 1)) || !oneOf(states, record.pipelineState)) throw Error('Invalid heartbeat');
  } else if (record.type === 'pose') {
    const { input, poses, playerCount } = record;
    if (!integer(record.seq, 1) || !integer(record.frameReceivedTimeMs) || !integer(record.resultTimeMs) || record.resultTimeMs < record.frameReceivedTimeMs ||
        !isObject(input) || !integer(input.width, 1) || !integer(input.height, 1) || typeof input.mirrored !== 'boolean' || !isArray(poses) || (playerCount !== 1 && playerCount !== 2) || poses.length > playerCount) throw Error('Invalid pose');
    let lastId = -1;
    for (const pose of poses) {
      if (!isObject(pose) || !integer(pose.playerId) || pose.playerId >= playerCount || pose.playerId <= lastId) throw Error('Invalid player ID/order');
      lastId = pose.playerId;
      if (!isArray(pose.landmarks) || pose.landmarks.length !== 33) throw Error('Expected 33 landmarks');
      for (const p of pose.landmarks) if (!isObject(p) || ![p.x, p.y, p.z].every(Number.isFinite) || !score(p.confidence)) throw Error('Invalid landmark');
    }
  } else throw Error('Unknown record type');
}
export function validate(record: unknown): ProtocolRecord {
  assertProtocolRecord(record);
  return record;
}

/** Byte-based limit, including incomplete UTF-8; network chunks can split anywhere. */
export class NdjsonDecoder {
  onRecord: (record: ProtocolRecord) => void;
  buffer: Uint8Array;
  length: number;
  decoder: TextDecoder;
  constructor(onRecord: (record: ProtocolRecord) => void) { this.onRecord = onRecord; this.buffer = new Uint8Array(MAX_BYTES); this.length = 0; this.decoder = new TextDecoder('utf-8', {fatal: true}); }
  push(chunk: Uint8Array) {
    let start = 0;
    for (let end = 0; end <= chunk.length; end++) {
      if (end < chunk.length && chunk[end] !== 10) continue;
      const part = chunk.subarray(start, end);
      if (this.length + part.length > MAX_BYTES) throw Error('Record exceeds 16 KiB');
      this.buffer.set(part, this.length); this.length += part.length;
      if (end < chunk.length) {
        const value = validate(JSON.parse(this.decoder.decode(this.buffer.subarray(0, this.length))));
        this.length = 0; this.onRecord(value);
      }
      start = end + 1;
    }
  }
  finish() { if (this.length) throw Error('Incomplete final record'); }
}

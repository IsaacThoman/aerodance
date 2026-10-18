// What the game and a phone send each other through the pairing server while their WebRTC
// connection is set up (server.ts relays them). Server-safe: no imports, so the pairing
// server's container only needs this folder.

/** A pairing code: six digits, typed on the phone's keypad or carried by the QR code's link. */
export const CODE_DIGITS = 6;
export const isPairingCode = (value: unknown): value is string => typeof value === 'string' && /^\d{6}$/.test(value);
/** The digits of a typed or pasted code ("123 456" → "123456"). */
export const codeDigits = (input: string) => input.replace(/\D/g, '').slice(0, CODE_DIGITS);
/** A code as people read it: "123 456". */
export const spacedCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

export type PairingRole = 'host' | 'phone';
export interface IceServer { urls: string | string[]; username?: string; credential?: string; }
/** POST /rooms: the game's new room. */
export interface CreatedRoom { code: string; token: string; iceServers: IceServer[]; }
/** POST /rooms/:code/join: the phone's place in it. */
export interface JoinedRoom { token: string; iceServers: IceServer[]; }

/** An ICE candidate as RTCIceCandidate.toJSON() gives it; candidate '' ends the list. */
export interface IceCandidate { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null; }

/**
 * Relayed between the two sides. epoch numbers the game's connection attempts, so a late
 * answer or candidate from an abandoned attempt is ignored.
 *
 *   hello    phone → game: here I am, (re)connect me
 *   offer    game → phone
 *   answer   phone → game
 *   ice      either way
 */
export type Signal =
  | { type: 'hello'; device: string }
  | { type: 'offer'; epoch: number; sdp: string }
  | { type: 'answer'; epoch: number; sdp: string }
  | { type: 'ice'; epoch: number; candidate: IceCandidate };

/** From the server itself: the other side's events stream opened or closed (left: the phone left for good), or the room is gone. */
export type ServerEvent = { type: 'peer'; present: boolean; left?: boolean } | { type: 'closed'; reason: string };
export type PairingEvent = Signal | ServerEvent;

/** The largest signal the server relays (an SDP is a few kilobytes). */
export const MAX_SIGNAL_BYTES = 32 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const epochOf = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const stringOrNull = (value: unknown) => value === undefined || value === null || typeof value === 'string';

function isCandidate(value: unknown): value is IceCandidate {
  return isObject(value) && typeof value.candidate === 'string' && stringOrNull(value.sdpMid) && stringOrNull(value.usernameFragment) &&
    (value.sdpMLineIndex === undefined || value.sdpMLineIndex === null || (Number.isSafeInteger(value.sdpMLineIndex) && (value.sdpMLineIndex as number) >= 0));
}

/** A relayed signal or server event, or null for anything else. */
export function parsePairingEvent(value: unknown): PairingEvent | null {
  if (!isObject(value)) return null;
  switch (value.type) {
    case 'hello': return typeof value.device === 'string' ? { type: 'hello', device: value.device.slice(0, 80) } : null;
    case 'offer':
    case 'answer': return epochOf(value.epoch) && typeof value.sdp === 'string' ? { type: value.type, epoch: value.epoch as number, sdp: value.sdp } : null;
    case 'ice': return epochOf(value.epoch) && isCandidate(value.candidate) ? { type: 'ice', epoch: value.epoch as number, candidate: value.candidate } : null;
    case 'peer': return typeof value.present === 'boolean' ? { type: 'peer', present: value.present, ...(value.left === true ? { left: true } : {}) } : null;
    case 'closed': return typeof value.reason === 'string' ? { type: 'closed', reason: value.reason } : null;
    default: return null;
  }
}

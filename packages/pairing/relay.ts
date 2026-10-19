// The pairing server's relay: how a game without WebRTC (the Apple TV app) and its phone talk
// through the server instead. Server-safe: no imports, so the pairing server's container only
// needs this folder (and ws).
//
// After the phone's hello, a game that can't use WebRTC opens a WebSocket to
// /rooms/:code/link?token=…&epoch=N and, once it's open, sends the phone a relay signal
// for attempt N; the phone opens its own socket for N. When both are there the server tells
// both, and from then on forwards each side's frames to the other unread:
//
//   text 'L' + message   the live channel: poses and clock pings (dropped when late)
//   text 'C' + message   the control channel: settings and status (reliable, in order)
//   text 'S' + event     from the server: { type: 'open' } once both sides are connected
//   binary               phone → game only: a JPEG of the phone's camera for a setup preview
//
// The messages are packages/pairing/link.ts's, as the WebRTC data channels carry them; each
// side checks what it receives. The link ends when either socket closes: the server closes
// the other, and the phone says hello again as after a dropped WebRTC connection.

export const LIVE_PREFIX = 'L';
export const CONTROL_PREFIX = 'C';
export const SERVER_PREFIX = 'S';
/** The largest frame either way: a pose message or a preview picture is a few kilobytes. */
export const MAX_RELAY_FRAME = 64 * 1024;
/** Frames from the server. */
export type RelayEvent = { type: 'open' };
/** Close codes the server sends, so a side can tell why its link ended. */
export const RELAY_CLOSE = {
  /** The other side left or lost its connection. */
  peerGone: 4000,
  /** A newer connection attempt replaced this one (or the phone's epoch isn't the game's). */
  replaced: 4001,
  /** The pairing ended. */
  ended: 4002,
  /** This side sent something it may not (a frame too large, or a kind it can't send). */
  refused: 4003,
} as const;

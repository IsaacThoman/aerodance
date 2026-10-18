import { DEFAULT_ICE_SERVERS } from './server.ts';
import type { PairingServerOptions } from './server.ts';
import { cloudflareTurn, parseIceServers } from './turn.ts';

/*
 * The pairing server's ICE settings from the environment (the Compose service and the Vite
 * dev server read the same variables):
 *
 *   CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_API_TOKEN   a Cloudflare Realtime TURN key: each
 *                                     game and phone gets short-lived TURN credentials
 *   PAIRING_ICE_SERVERS               a JSON array of RTCIceServer entries: used without a
 *                                     Cloudflare key, and whenever Cloudflare can't be reached
 *                                     (default: a public STUN server)
 */

export function pairingOptions(env: Record<string, string | undefined> = process.env): PairingServerOptions {
  let iceServers = DEFAULT_ICE_SERVERS;
  if (env.PAIRING_ICE_SERVERS) {
    // The parse error isn't repeated: it may quote the value, credentials and all.
    let parsed: unknown;
    try { parsed = JSON.parse(env.PAIRING_ICE_SERVERS); } catch { throw Error('PAIRING_ICE_SERVERS is not valid JSON'); }
    try { iceServers = parseIceServers(parsed); } catch (error) {
      throw Error(`PAIRING_ICE_SERVERS must be a JSON array of RTCIceServer entries: ${error instanceof Error ? error.message : error}`, { cause: error });
    }
  }
  const keyId = env.CLOUDFLARE_TURN_KEY_ID?.trim(), apiToken = env.CLOUDFLARE_TURN_API_TOKEN?.trim();
  if (!keyId !== !apiToken) throw Error('Set both CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN, or neither');
  return { iceServers, ...(keyId && apiToken ? { ice: cloudflareTurn({ keyId, apiToken }) } : {}) };
}

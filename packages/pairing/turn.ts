import type { IceServer } from './signals.ts';

/*
 * TURN through Cloudflare Realtime: short-lived credentials for each game and phone, so the
 * two can still connect when they can't reach each other directly (guest Wi-Fi that keeps
 * devices apart, a phone on mobile data). The key and its API token stay on the server.
 * https://developers.cloudflare.com/realtime/turn/generate-credentials/
 *
 * Anyone who can create a room receives credentials, so they're tied to the room: the
 * pairing server revokes them when the room ends, and they expire after ttlSeconds anyway.
 *
 * const ice = cloudflareTurn({ keyId, apiToken });
 * createPairingServer({ ice });  // each new room and join gets fresh credentials
 */

/** Where the pairing server gets ICE servers for each side, and gives their credentials back. */
export interface IceSource {
  issue(): Promise<IceServer[]>;
  revoke?(servers: IceServer[]): Promise<void>;
}

export interface CloudflareTurnOptions {
  keyId: string;
  apiToken: string;
  /** How long the credentials work: as long as a room can last. */
  ttlSeconds?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const API = 'https://rtc.live.cloudflare.com/v1/turn/keys';

// Browsers block port 53, so a TURN URL on it only times out.
const usable = (url: string) => !/:53(\?|$)/.test(url);

/** RTCIceServer entries from untrusted JSON, without the URLs browsers can't use. */
export function parseIceServers(value: unknown): IceServer[] {
  if (!Array.isArray(value)) throw Error('Expected an array of ICE servers');
  return value.flatMap((entry): IceServer[] => {
    if (typeof entry !== 'object' || entry === null) throw Error('Expected ICE server objects');
    const { urls, username, credential } = entry as Record<string, unknown>;
    const list = typeof urls === 'string' ? [urls] : Array.isArray(urls) && urls.every((u) => typeof u === 'string') ? urls as string[] : null;
    if (!list) throw Error('An ICE server needs urls');
    if ((username !== undefined && typeof username !== 'string') || (credential !== undefined && typeof credential !== 'string')) throw Error('ICE server credentials must be strings');
    const kept = list.filter(usable);
    // A browser refuses a TURN server without credentials outright.
    if (kept.some((url) => /^turns?:/.test(url)) && (!username || !credential)) throw Error('A TURN server needs a username and credential');
    return kept.length ? [{ urls: kept, ...(username !== undefined ? { username } : {}), ...(credential !== undefined ? { credential } : {}) }] : [];
  });
}

/** Fresh ICE servers (Cloudflare's STUN and TURN, with credentials) from a Cloudflare TURN key. */
export function cloudflareTurn({ keyId, apiToken, ttlSeconds = 12 * 60 * 60, timeoutMs = 3000, fetch: fetchFn = fetch }: CloudflareTurnOptions): IceSource {
  const key = `${API}/${encodeURIComponent(keyId)}/credentials`;
  const headers = { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' };
  return {
    async issue() {
      const res = await fetchFn(`${key}/generate-ice-servers`, {
        method: 'POST', headers, body: JSON.stringify({ ttl: ttlSeconds }), signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw Error(`Cloudflare TURN answered ${res.status}`);
      const body: unknown = await res.json();
      const servers = parseIceServers(typeof body === 'object' && body !== null ? (body as { iceServers?: unknown }).iceServers : undefined);
      if (!servers.length) throw Error('Cloudflare TURN returned no usable servers');
      return servers;
    },
    async revoke(servers) {
      const names = new Set(servers.flatMap((s) => (s.username ? [s.username] : [])));
      for (const name of names) {
        const res = await fetchFn(`${key}/${encodeURIComponent(name)}/revoke`, { method: 'POST', headers, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw Error(`Cloudflare TURN answered ${res.status} to a revoke`);
      }
    },
  };
}

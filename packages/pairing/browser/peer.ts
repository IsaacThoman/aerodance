import type { IceCandidate, IceServer, Signal } from '../signals.ts';

/*
 * One WebRTC connection attempt between the game and a phone, numbered by its epoch: the
 * game offers, the phone answers, and both trickle ICE candidates through the pairing
 * server. Candidates that arrive before the other side's description wait for it (the
 * server relays signals in the order it receives them, which needn't be the order sent).
 *
 * Game:  const peer = new Peer({ epoch, iceServers, send }); create channels; await peer.offer();
 *        later peer.accept(answer.sdp) and peer.addIce(candidate)
 * Phone: const peer = new Peer({ epoch: offer.epoch, iceServers, send }); await peer.answer(offer.sdp);
 */

export type CreatePeerConnection = (config: RTCConfiguration) => RTCPeerConnection;
export interface PeerOptions {
  epoch: number;
  iceServers: IceServer[];
  /** Posts a signal for the other side. */
  send: (signal: Signal) => void;
  createConnection?: CreatePeerConnection;
}

export class Peer {
  epoch: number;
  pc: RTCPeerConnection;
  send: (signal: Signal) => void;
  pending: IceCandidate[] = [];
  closed = false;
  constructor({ epoch, iceServers, send, createConnection = (config) => new RTCPeerConnection(config) }: PeerOptions) {
    this.epoch = epoch; this.send = send;
    this.pc = createConnection({ iceServers });
    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate && !this.closed) send({ type: 'ice', epoch, candidate: candidate.toJSON() as IceCandidate });
    };
  }

  /** The game: describe this side and send the offer. */
  async offer() {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    this.sendDescription('offer');
  }

  /** The phone: take the game's offer and send an answer. */
  async answer(sdp: string) {
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    await this.flush();
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    this.sendDescription('answer');
  }

  /** The game: take the phone's answer. */
  async accept(sdp: string) {
    if (this.pc.signalingState !== 'have-local-offer') return;
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
    await this.flush();
  }

  async addIce(candidate: IceCandidate) {
    if (!this.pc.remoteDescription) { this.pending.push(candidate); return; }
    // A candidate the connection can't use (another network, a stale ufrag) is just skipped.
    await this.pc.addIceCandidate(candidate).catch(() => {});
  }

  close() {
    this.closed = true;
    this.pc.onicecandidate = null;
    this.pc.onconnectionstatechange = null;
    this.pc.ondatachannel = null;
    this.pc.close();
  }

  sendDescription(type: 'offer' | 'answer') {
    const sdp = this.pc.localDescription?.sdp;
    if (sdp && !this.closed) this.send({ type, epoch: this.epoch, sdp });
  }

  async flush() {
    const pending = this.pending;
    this.pending = [];
    for (const candidate of pending) await this.addIce(candidate);
  }
}

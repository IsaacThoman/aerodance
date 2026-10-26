import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { importSongZip, listSavedSongs } from '../src/songs/customSongs.ts';
import { createSongTransfer } from '../src/songs/songTransfer.ts';
import type { SongTransfer, TransferItem } from '../src/songs/songTransfer.ts';
import { hostTransfer, joinTransfer, transferCode, transferDeviceName, transferUrl } from '../src/songs/transferLink.ts';
import type { TransferLink, TransferLinkOptions } from '../src/songs/transferLink.ts';
import { createRoom } from '../../../packages/pairing/browser/signalChannel.ts';
import { createFakeConnection, fakeConnectionOn, fetchEventStream, pairingServer, until } from './fixtures/fakePairing.ts';
import { bundleFixture, silentWav } from './fixtures/songBundle.ts';
import { bundleFiles, exportZip, memoryStore } from './helpers/customSongs.ts';

/** A song big enough to go in many pieces. */
function song(id = 'fixture', title = 'Fixture routine') {
  const fixture = bundleFixture();
  fixture.song.songId = id;
  fixture.song.title = title;
  fixture.choreography.songId = id;
  fixture.audio = silentWav(30_000);
  return exportZip(bundleFiles(fixture));
}

type Side = { link: TransferLink; transfer: () => SongTransfer | null; store: ReturnType<typeof memoryStore>; devices: string[] };
/** One end: its link, and a song transfer over each connection it opens. */
function side(t: TestContext, make: (opts: TransferLinkOptions) => TransferLink, device: string, extra: Partial<TransferLinkOptions> = {}): Side {
  const store = memoryStore();
  let transfer: SongTransfer | null = null;
  const devices: string[] = [];
  const link = make({ device, createStream: fetchEventStream, origin: () => 'https://game.test', ...extra,
    onChannel: (channel, other) => { devices.push(other); transfer = createSongTransfer({ channel, device, store, warn: () => {} }); } });
  t.after(() => link.close());
  return { link, transfer: () => transfer, store, devices };
}

async function sendOne(from: Side, to: Side, id = 'fixture') {
  const before = from.transfer()!.view().outgoing.length;
  from.transfer()!.send([{ id, title: id }]);
  const item = await until((): TransferItem | null => {
    const o = from.transfer()!.view().outgoing;
    return o.length > before && ['done', 'failed'].includes(o.at(-1)!.status) ? o.at(-1)! : null;
  }, 'the song', 15_000);
  assert.equal(item.status, 'done', item.text);
  assert.ok((await listSavedSongs(to.store)).some((s) => s.entry.id === id && !s.damaged));
}

test('a guest joins the host’s code over WebRTC and either can send the other a song', async (t) => {
  const base = await pairingServer(t);
  const host = side(t, (o) => hostTransfer(o), 'Apple TV', { base, createConnection: createFakeConnection });
  await until(() => host.link.view().status === 'waiting', 'a code');
  const { code, url } = host.link.view();
  assert.match(code, /^\d{6}$/);
  assert.equal(url, `https://game.test/?transfer=${code}`);
  await importSongZip(song(), { store: host.store });
  const guest = side(t, (o) => joinTransfer(code, o), 'iPhone', { base, createConnection: createFakeConnection });
  await importSongZip(song('other', 'Other'), { store: guest.store });
  await until(() => host.link.view().status === 'connected' && guest.link.view().status === 'connected', 'both connected');
  assert.equal(host.link.view().transport, 'webrtc');
  assert.equal(host.link.view().device, 'iPhone');
  assert.deepEqual(host.devices, ['iPhone']);
  await until(() => guest.transfer()?.view().peer && host.transfer()?.view().peer, 'hellos');
  assert.equal(guest.transfer()!.view().peer!.device, 'Apple TV');
  await sendOne(host, guest);
  await sendOne(guest, host, 'other');
});

test('a host without WebRTC (the Apple TV app) connects through the relay', async (t) => {
  const base = await pairingServer(t);
  const host = side(t, (o) => hostTransfer(o), 'Apple TV', { base, transport: 'relay' });
  await until(() => host.link.view().code, 'a code');
  await importSongZip(song(), { store: host.store });
  const guest = side(t, (o) => joinTransfer(host.link.view().code, o), 'Mac', { base, createConnection: createFakeConnection });
  await importSongZip(song('other', 'Other'), { store: guest.store });
  await until(() => host.link.view().status === 'connected' && guest.link.view().status === 'connected', 'both connected');
  assert.equal(host.link.view().transport, 'relay');
  assert.equal(guest.link.view().transport, 'relay');
  await until(() => guest.transfer()?.view().peer && host.transfer()?.view().peer, 'hellos');
  await sendOne(guest, host, 'other');
  await sendOne(host, guest);
});

test('a WebRTC connection that fails falls back to the relay', async (t) => {
  const base = await pairingServer(t);
  const host = side(t, (o) => hostTransfer(o), 'Laptop', { base, createConnection: fakeConnectionOn(() => 'fail') });
  await until(() => host.link.view().code, 'a code');
  await importSongZip(song(), { store: host.store });
  const guest = side(t, (o) => joinTransfer(host.link.view().code, o), 'iPad', { base, createConnection: createFakeConnection });
  await until(() => host.link.view().status === 'connected' && guest.link.view().status === 'connected', 'both connected');
  assert.equal(host.link.view().transport, 'relay');
  await until(() => guest.transfer()?.view().peer, 'hello');
  await sendOne(host, guest);
});

test('when the guest leaves, the host waits on the same code for another device', async (t) => {
  const base = await pairingServer(t);
  const host = side(t, (o) => hostTransfer(o), 'Apple TV', { base, transport: 'relay' });
  await until(() => host.link.view().code, 'a code');
  const { code } = host.link.view();
  const first = side(t, (o) => joinTransfer(code, o), 'iPhone', { base, createConnection: createFakeConnection });
  await until(() => host.link.view().status === 'connected', 'the first guest');
  first.link.close();
  await until(() => host.link.view().status === 'waiting', 'waiting again');
  assert.equal(host.transfer()!.view().closed, true);
  const second = side(t, (o) => joinTransfer(code, o), 'Mac', { base, createConnection: createFakeConnection });
  await until(() => host.link.view().status === 'connected' && second.link.view().status === 'connected', 'the second guest');
  assert.equal(host.link.view().device, 'Mac');
  // The host ending the transfer ends the guest's link.
  host.link.close();
  await until(() => second.link.view().status === 'ended', 'the guest to hear');
  assert.equal(second.link.view().error, 'The other device stopped transferring songs.');
});

test('a wrong code, or a phone pairing code, says why', async (t) => {
  const base = await pairingServer(t);
  const wrong = side(t, (o) => joinTransfer('000000', o), 'iPhone', { base });
  await until(() => wrong.link.view().status === 'ended', 'the refusal');
  assert.equal(wrong.link.view().error, 'No game is waiting with that code.');
  const pairing = await createRoom(base);
  const phone = side(t, (o) => joinTransfer(pairing.code, o), 'iPhone', { base });
  await until(() => phone.link.view().status === 'ended', 'the refusal');
  assert.equal(phone.link.view().error, 'That code is for pairing a phone as the camera, not for sending songs.');
});

test('devices name themselves, and a transfer link carries its code', () => {
  assert.equal(transferDeviceName('', 'tvos'), 'Apple TV');
  assert.equal(transferDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 'ios'), 'iPhone');
  assert.equal(transferDeviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 'web'), 'Mac');
  assert.equal(transferDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'web'), 'Windows PC');
  assert.equal(transferDeviceName('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile', 'web'), 'Android phone');
  assert.equal(transferUrl('123456', 'https://aerodance.party/'), 'https://aerodance.party/?transfer=123456');
  assert.equal(transferCode('?transfer=123456'), '123456');
  assert.equal(transferCode('?transfer=12345'), '');
  assert.equal(transferCode('?input=ghost'), '');
});

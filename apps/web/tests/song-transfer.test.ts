import test from 'node:test';
import assert from 'node:assert/strict';
import { importSongZip, listSavedSongs } from '../src/songs/customSongs.ts';
import { PIECE_BYTES, WINDOW_BYTES, createSongTransfer, parseTransferMessage, savedSongZip } from '../src/songs/songTransfer.ts';
import type { SongTransfer, TransferChannel, TransferView } from '../src/songs/songTransfer.ts';
import { readSongZip } from '../src/songs/customSongs.ts';
import { bundleFixture, silentWav } from './fixtures/songBundle.ts';
import { bundleFiles, exportZip, memoryStore } from './helpers/customSongs.ts';

/** Two connected channel ends: messages arrive in order, a turn later. inFlight: one end's bytes sent and not yet acknowledged. */
function channelPair() {
  const log: { from: 'a' | 'b'; kind: 'text' | 'binary'; size: number; text?: string }[] = [];
  const make = (name: 'a' | 'b') => {
    const end: TransferChannel & { other?: TransferChannel & { open: boolean }; open: boolean } = {
      open: true,
      bufferedAmount: 0,
      onText: null, onBinary: null, onClose: null,
      sendText(text) {
        if (!end.open) throw Error('closed');
        log.push({ from: name, kind: 'text', size: text.length, text });
        setTimeout(() => { if (end.other?.open) end.other.onText?.(text); });
      },
      sendBinary(bytes) {
        if (!end.open) throw Error('closed');
        log.push({ from: name, kind: 'binary', size: bytes.byteLength });
        const copy = bytes.slice().buffer;
        setTimeout(() => { if (end.other?.open) end.other.onBinary?.(copy); });
      },
      close() {
        if (!end.open) return;
        end.open = false;
        end.onClose?.();
        const { other } = end;
        setTimeout(() => other?.close());
      },
    };
    return end;
  };
  const a = make('a'), b = make('b');
  a.other = b; b.other = a;
  return { a, b, log };
}

/** A song's files with a bigger audio file, so it goes in many pieces. */
function bigSong({ id = 'fixture', revision = 1, title = 'Fixture routine', audioMs = 40_000 } = {}) {
  const fixture = bundleFixture();
  fixture.song.songId = id;
  fixture.song.title = title;
  fixture.song.bundleRevision = revision;
  fixture.choreography.songId = id;
  fixture.audio = silentWav(audioMs);
  return bundleFiles(fixture);
}

async function until(check: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function pair({ aStore = memoryStore(), bStore = memoryStore() } = {}) {
  const { a, b, log } = channelPair();
  const views = { a: null as TransferView | null, b: null as TransferView | null };
  const saved: string[] = [];
  const ta = createSongTransfer({ channel: a, device: 'Laptop', store: aStore, onChange: (v) => { views.a = v; }, warn: () => {} });
  const tb = createSongTransfer({ channel: b, device: 'Apple TV', store: bStore, onChange: (v) => { views.b = v; }, onSaved: (r) => saved.push(r.entry.id), warn: () => {} });
  await until(() => !!ta.view().peer && !!tb.view().peer, 'both hellos');
  return { ta, tb, aStore, bStore, a, b, log, saved };
}
/** Stops the sender hearing acknowledgements, so it sends one window and waits. */
function stall(a: TransferChannel) {
  const onText = a.onText!;
  a.onText = (text) => { if (!text.includes('"ack"')) onText(text); };
}
const outgoing = (t: SongTransfer) => t.view().outgoing.at(-1)!;
const incoming = (t: SongTransfer) => t.view().incoming.at(-1)!;
const settled = (t: SongTransfer) => ['done', 'failed'].includes(outgoing(t)?.status ?? '');

test('each side says hello with what it calls itself and the songs it has', async () => {
  const aStore = memoryStore();
  await importSongZip(exportZip(bigSong({ audioMs: 1000 })), { store: aStore });
  const { ta, tb } = await pair({ aStore });
  assert.equal(ta.view().peer!.device, 'Apple TV');
  assert.deepEqual(ta.view().peer!.songs, []);
  assert.equal(tb.view().peer!.device, 'Laptop');
  assert.deepEqual(tb.view().peer!.songs.map((s) => [s.id, s.title, s.revision]), [['fixture', 'Fixture routine', 1]]);
});

test('a song goes over in pieces, never more than a window unacknowledged, and the receiver saves it as an import', async () => {
  const aStore = memoryStore();
  await importSongZip(exportZip(bigSong()), { store: aStore });
  const { ta, tb, bStore, log, saved } = await pair({ aStore });
  // Bytes from A not yet acknowledged by B, at every send.
  let inFlight = 0, worst = 0, acked = 0, sent = 0;
  const watch = setInterval(() => {
    sent = log.filter((e) => e.from === 'a' && e.kind === 'binary').reduce((n, e) => n + e.size - 8, 0);
    const acks = log.filter((e) => e.from === 'b' && e.text?.includes('"ack"')).map((e) => JSON.parse(e.text!).received as number);
    acked = Math.max(0, ...acks);
    inFlight = sent - acked;
    worst = Math.max(worst, inFlight);
  }, 0);
  ta.send([{ id: 'fixture', title: 'Fixture routine' }]);
  await until(() => settled(ta), 'the result');
  clearInterval(watch);
  const item = outgoing(ta);
  assert.equal(item.status, 'done', item.text);
  assert.equal(item.text, 'Sent “Fixture routine” to Apple TV.');
  assert.ok(item.size > 4 * PIECE_BYTES, `${item.size} bytes went in many pieces`);
  assert.ok(worst <= WINDOW_BYTES, `${worst} bytes were unacknowledged at once`);
  const pieces = log.filter((e) => e.from === 'a' && e.kind === 'binary');
  assert.equal(pieces.length, Math.ceil(item.size / PIECE_BYTES));
  assert.ok(pieces.every((p) => p.size <= PIECE_BYTES + 8));
  assert.equal(incoming(tb).status, 'done');
  assert.equal(incoming(tb).text, 'Received “Fixture routine”.');
  assert.deepEqual(saved, ['fixture']);
  assert.deepEqual((await listSavedSongs(bStore)).map((s) => [s.entry.id, s.damaged]), [['fixture', false]]);
  // The receiver's files are the sender's.
  for (const [path, bytes] of aStore.files.get('fixture')!) assert.deepEqual(bStore.files.get('fixture')!.get(path), bytes);
  // And the sender hears that the receiver has it now.
  await until(() => ta.view().peer!.songs.length === 1, 'the receiver’s new list');
});

test('sending several queues them, one at a time, and each side can send at once', async () => {
  const aStore = memoryStore(), bStore = memoryStore();
  await importSongZip(exportZip(bigSong({ id: 'one', title: 'One', audioMs: 8000 })), { store: aStore });
  await importSongZip(exportZip(bigSong({ id: 'two', title: 'Two', audioMs: 8000 })), { store: aStore });
  await importSongZip(exportZip(bigSong({ id: 'three', title: 'Three', audioMs: 8000 })), { store: bStore });
  const { ta, tb } = await pair({ aStore, bStore });
  ta.send([{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }, { id: 'one', title: 'One' }]);
  tb.send([{ id: 'three', title: 'Three' }]);
  // Only one of A's is on its way at a time.
  assert.deepEqual(ta.view().outgoing.map((o) => o.status), ['sending', 'waiting']);
  await until(() => ta.view().outgoing.every((o) => o.status === 'done') && tb.view().outgoing.every((o) => o.status === 'done'), 'all three');
  assert.deepEqual((await listSavedSongs(bStore)).map((s) => s.entry.id).sort(), ['one', 'three', 'two']);
  assert.deepEqual((await listSavedSongs(aStore)).map((s) => s.entry.id).sort(), ['one', 'three', 'two']);
});

test('without asking, the receiver keeps the same copy or a later revision and replaces another copy of the same revision', async () => {
  const aStore = memoryStore(), bStore = memoryStore();
  await importSongZip(exportZip(bigSong({ revision: 2, audioMs: 2000 })), { store: aStore });
  await importSongZip(exportZip(bigSong({ revision: 2, audioMs: 2000 })), { store: bStore });
  const { ta, tb } = await pair({ aStore, bStore });
  ta.send([{ id: 'fixture', title: 'Fixture routine' }]);
  await until(() => settled(ta), 'the same copy');
  assert.equal(outgoing(ta).text, 'Apple TV already has “Fixture routine”.');
  assert.equal(incoming(tb).text, 'Already had “Fixture routine”.');

  // Another copy of revision 2 (another song.json) replaces it.
  await importSongZip(exportZip(bigSong({ revision: 2, audioMs: 3000, title: 'Fixture routine (take 2)' })), { store: aStore, confirmReplace: () => true });
  ta.send([{ id: 'fixture', title: 'Fixture routine (take 2)' }]);
  await until(() => settled(ta) && ta.view().outgoing.length === 2, 'another copy');
  assert.equal(outgoing(ta).text, 'Updated “Fixture routine (take 2)” on Apple TV.');
  assert.equal(bStore.records.get('fixture')!.sizes.get('audio.wav'), silentWav(3000).length);

  // A later revision there stays.
  await importSongZip(exportZip(bigSong({ revision: 3, audioMs: 1000 })), { store: bStore });
  ta.send([{ id: 'fixture', title: 'Fixture routine (take 2)' }]);
  await until(() => settled(ta) && ta.view().outgoing.length === 3, 'an older revision');
  assert.equal(outgoing(ta).status, 'done');
  assert.equal(incoming(tb).text, 'Already had “Fixture routine” (a later revision).');
  assert.equal(outgoing(ta).text, 'Apple TV already has “Fixture routine (take 2)”.');
  assert.equal(bStore.records.get('fixture')!.entry.bundleRevision, 3);
});

test('a song that doesn’t check out at the receiver fails on both sides with why', async () => {
  const aStore = memoryStore();
  await importSongZip(exportZip(bigSong({ audioMs: 2000 })), { store: aStore });
  // Its audio changes after it was saved: its checksum no longer matches.
  const audio = aStore.files.get('fixture')!.get('audio.wav')!;
  audio[100] ^= 0xff;
  const { ta, tb, bStore } = await pair({ aStore });
  ta.send([{ id: 'fixture', title: 'Fixture routine' }]);
  await until(() => settled(ta), 'the result');
  assert.equal(outgoing(ta).status, 'failed');
  assert.match(outgoing(ta).text, /couldn't be saved: That song can't be played/);
  assert.equal(incoming(tb).status, 'failed');
  assert.equal(bStore.records.size, 0);
});

test('the connection closing partway fails what was on its way, on both sides', async () => {
  const aStore = memoryStore();
  await importSongZip(exportZip(bigSong({ audioMs: 60_000 })), { store: aStore });
  const { ta, tb, a, bStore } = await pair({ aStore });
  stall(a);
  ta.send([{ id: 'fixture', title: 'Fixture routine' }]);
  await until(() => (tb.view().incoming[0]?.done ?? 0) === WINDOW_BYTES, 'a window of pieces');
  a.close();
  await until(() => tb.view().closed, 'the other side to see it close');
  assert.equal(outgoing(ta).status, 'failed');
  assert.equal(outgoing(ta).text, 'The connection to Apple TV closed.');
  assert.equal(incoming(tb).status, 'failed');
  assert.equal(incoming(tb).text, 'The connection to Laptop closed.');
  assert.equal(bStore.records.size, 0);
});

test('closing the transfer tells the other side the song stopped coming', async () => {
  const aStore = memoryStore();
  await importSongZip(exportZip(bigSong({ audioMs: 60_000 })), { store: aStore });
  const { ta, tb, a } = await pair({ aStore });
  stall(a);
  ta.send([{ id: 'fixture', title: 'Fixture routine' }]);
  await until(() => (tb.view().incoming[0]?.done ?? 0) === WINDOW_BYTES, 'a window of pieces');
  ta.close();
  await until(() => incoming(tb).status === 'failed', 'the cancel');
  assert.equal(incoming(tb).text, 'Laptop stopped sending “Fixture routine”.');
  assert.equal(outgoing(ta).status, 'failed');
});

test('a saved song zips as Dance Studio exports it, and messages from the other side are checked', async () => {
  const store = memoryStore();
  await importSongZip(exportZip(bigSong({ audioMs: 1000 })), { store });
  const saved = await savedSongZip('fixture', store);
  assert.equal(saved!.title, 'Fixture routine');
  const { name, files } = await readSongZip(new Blob([saved!.zip]));
  assert.equal(name, 'fixture');
  assert.deepEqual([...files.keys()].sort(), ['audio.wav', 'checksums.json', 'choreography.adpose', 'song.json']);
  assert.equal(await savedSongZip('missing', store), undefined);

  assert.equal(parseTransferMessage({ type: 'offer', id: -1, songId: 'x', size: 10 }), null);
  assert.equal(parseTransferMessage({ type: 'offer', id: 1, songId: 'x', size: 0 }), null);
  assert.equal(parseTransferMessage({ type: 'nope' }), null);
  assert.equal(parseTransferMessage('hello'), null);
  assert.deepEqual(parseTransferMessage({ type: 'hello', device: 'TV', songs: [{ id: 'a', revision: 1 }, { id: 2 }, 'x'] }),
    { type: 'hello', device: 'TV', songs: [{ id: 'a', title: 'a', artist: '', revision: 1, sha256: '' }] });
  assert.deepEqual(parseTransferMessage({ type: 'result', id: 3, ok: true, status: 'weird', text: 'ok' }), { type: 'result', id: 3, ok: true, text: 'ok' });
});

test('an offer bigger than a song can be is turned down at once', async () => {
  const { a, b } = channelPair();
  const tb = createSongTransfer({ channel: b, device: 'Apple TV', store: memoryStore(), warn: () => {} });
  const sent: string[] = [];
  a.onText = (text) => sent.push(text);
  a.sendText(JSON.stringify({ type: 'offer', id: 7, songId: 'huge', title: 'Huge', size: 1024 ** 3 }));
  await until(() => sent.some((s) => s.includes('"result"')), 'the refusal');
  const result = JSON.parse(sent.find((s) => s.includes('"result"'))!);
  assert.deepEqual(result, { type: 'result', id: 7, ok: false, text: '“Huge” is too big to be a song.' });
  assert.equal(incoming(tb).status, 'failed');
});

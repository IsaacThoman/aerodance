import { qualityFor } from '../../../../packages/pose/choreography.ts';
import type { Pose } from '../../../../packages/pose/choreography.ts';
import { songChoreographyFromTimeline } from '../../../../packages/pose/song.ts';
import type { CatalogSong, Song, SongTimeline } from '../../../../packages/pose/song.ts';
import { encodePoseFile } from '../../../../packages/pose/binary.ts';

/** A small valid song bundle (song.json, the choreography as objects, silent audio) and its catalog entry. */
export interface BundleFixture {
  song: Song;
  choreography: SongTimeline;
  audio: Uint8Array<ArrayBuffer>;
  entry: CatalogSong;
}

/** Where the fixture's dancer stands across the picture: left to right from 0.3 to 0.7. */
export const dancerX = (dancer: number, dancers: number) => 0.3 + (dancer * 0.4) / Math.max(1, dancers - 1);

/** The fixture with `dancers` dancers (song.json leaves a duet's dancerCount out, like older songs). */
export function bundleFixture(dancers = 2): BundleFixture {
  const song: Song = {
    schema:'aerodance.song',schemaVersion:1,songId:'fixture',bundleRevision:1,title:'Fixture routine',artist:'Test artist',
    songwriters:[],choreographers:[],durationMs:1000,playableStartMs:100,playableEndMs:900,supportedPlayerCounts:[1,2,3,4],
    audio:{path:'audio.wav',mimeType:'audio/wav'},choreography:{path:'choreography.adpose',schemaVersion:2},
    coachMode:'mirror-player',rigProfile:'frutiger-seven-bone-v1',
    rights:{audio:{license:'test',attribution:''},choreography:{license:'test',attribution:''}},
    createdAt:'2026-10-10T00:00:00Z',publishedAt:'2026-10-10T00:00:00Z',build:{compilerVersion:'test',projectRevision:1},
    ...(dancers === 2 ? {} : { dancerCount: dancers }),
  };
  const ids = Array.from({length:dancers},(_,id)=>id);
  const poses = ids.map((playerId): Pose => ({playerId,landmarks:Array.from({length:33},(_,i)=>({x:dancerX(playerId,dancers),y:i<23?.3:.7,z:0,confidence:.8}))}));
  const choreography: BundleFixture['choreography'] = {
    schema:'aerodance.choreography',schemaVersion:1,songId:song.songId,durationMs:1000,playableStartMs:100,playableEndMs:900,
    coordinates:{kind:'mediapipe-image',landmarkCount:33,ordering:'mediapipe-pose-33',xAxis:'right',yAxis:'down',zAxis:'away-from-camera',mirrored:false,depthUnit:'relative-image-width'},
    sampling:{targetRateHz:30,maxInterpolationGapMs:200,confidenceThreshold:.5},
    tracks:ids.map(playerId=>({playerId,label:`Player ${playerId+1}`,calibration:{inputWidth:640,inputHeight:480,torsoLength:.4,baseHip:{x:dancerX(playerId,dancers),y:.7,z:0},floorY:.7,profileVersion:1},unscorableIntervals:[{startMs:300,endMs:400,reason:'Test exclusion'}]})),
    samples:[100,300,500,700,900].map(songTimeMs=>({songTimeMs,poses:structuredClone(poses),quality:qualityFor(poses)}))
  };
  // One second of silent PCM, solely for automated browser tests; never cataloged publicly.
  const audio = silentWav(1000);
  const entry: CatalogSong = {id:song.songId,title:song.title,artist:song.artist,durationMs:1000,supportedPlayerCounts:[1,2,3,4],bundleRevision:1,bundle:'fixture/song.json',
    ...(dancers === 2 ? {} : { dancerCount: dancers })};
  return {song,choreography,audio,entry};
}

/** The fixture's choreography.adpose bytes. */
export const choreographyBytes = (fixture: Pick<BundleFixture, 'choreography'>) => encodePoseFile(songChoreographyFromTimeline(fixture.choreography));

/** Silent 8 kHz mono 16-bit PCM WAV lasting durationMs. */
export function silentWav(durationMs: number) {
  const data = Math.round(durationMs * 8) * 2;
  const audio = new Uint8Array(44 + data), view = new DataView(audio.buffer);
  const write = (offset: number, s: string) => [...s].forEach((c,i)=>view.setUint8(offset+i,c.charCodeAt(0)));
  write(0,'RIFF');view.setUint32(4,36 + data,true);write(8,'WAVE');write(12,'fmt ');view.setUint32(16,16,true);
  view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,8000,true);view.setUint32(28,16000,true);
  view.setUint16(32,2,true);view.setUint16(34,16,true);write(36,'data');view.setUint32(40,data,true);
  return audio;
}

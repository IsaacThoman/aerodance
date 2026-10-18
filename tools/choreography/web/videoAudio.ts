import type { ImportProgress } from './videoImport.ts';

export const MAX_AUDIO_BYTES = 128 * 1024 * 1024;
export interface VideoAudio { file: File; durationMs: number; }
type PcmBuffer = Pick<AudioBuffer, 'sampleRate' | 'numberOfChannels' | 'length' | 'getChannelData'>;

/** A bounded PCM file on the video's clock. Unwritten regions remain silence. */
export class VideoWave {
  bytes: Uint8Array<ArrayBuffer>;
  view: DataView<ArrayBuffer>;
  frames: number;
  readonly sampleRate: number;
  readonly channels: number;
  constructor(sampleRate: number, channels: number, durationMs: number) {
    this.sampleRate = sampleRate; this.channels = channels;
    if (!Number.isInteger(sampleRate) || sampleRate <= 0 || !Number.isInteger(channels) || channels < 1 || channels > 32 ||
      !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 3600000) throw Error('Unsupported video audio format');
    this.frames = Math.ceil(durationMs * sampleRate / 1000);
    const length = 44 + this.frames * channels * 2;
    if (length > MAX_AUDIO_BYTES) throw Error('Extracted audio exceeds 128 MiB. Use a shorter video or import compressed song audio separately.');
    this.bytes = new Uint8Array(length); this.view = new DataView(this.bytes.buffer);
    const text = (at: number, value: string) => this.bytes.set(new TextEncoder().encode(value), at);
    text(0, 'RIFF'); this.view.setUint32(4, length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
    this.view.setUint32(16, 16, true); this.view.setUint16(20, 1, true); this.view.setUint16(22, channels, true);
    this.view.setUint32(24, sampleRate, true); this.view.setUint32(28, sampleRate * channels * 2, true);
    this.view.setUint16(32, channels * 2, true); this.view.setUint16(34, 16, true);
    text(36, 'data'); this.view.setUint32(40, length - 44, true);
  }
  write(buffer: PcmBuffer, timestamp: number) {
    if (buffer.sampleRate !== this.sampleRate || buffer.numberOfChannels !== this.channels || !Number.isFinite(timestamp))
      throw Error('Video audio format changed during decoding. Import song audio separately.');
    const start = Math.round(timestamp * this.sampleRate);
    const first = Math.max(0, -start), end = Math.min(buffer.length, this.frames - start);
    for (let channel = 0; channel < this.channels; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let i = first; i < end; i++) {
        const value = Math.max(-1, Math.min(1, samples[i]));
        this.view.setInt16(44 + ((start + i) * this.channels + channel) * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
      }
    }
  }
}

export async function extractVideoAudio(file: File, durationMs: number, signal: AbortSignal,
  onProgress: (progress: ImportProgress) => void = () => {}): Promise<VideoAudio> {
  signal.throwIfAborted();
  const { Input, BlobSource, ALL_FORMATS, AudioBufferSink } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const abort = () => input.dispose();
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw Error('This video has no audio track. Uncheck “Use video audio as song audio” to import poses only.');
    if (!await track.canDecode()) throw Error('This browser cannot decode the video’s audio. Uncheck “Use video audio as song audio” and import song audio separately.');
    const wave = new VideoWave(track.sampleRate, track.numberOfChannels, durationMs);
    const sink = new AudioBufferSink(track);
    let decoded = false;
    for await (const { buffer, timestamp } of sink.buffers()) {
      signal.throwIfAborted();
      if (timestamp * 1000 >= durationMs) break;
      wave.write(buffer, timestamp);
      decoded = true;
      onProgress({ fraction: Math.min(1, Math.max(0, timestamp * 1000 / durationMs)), message: 'Extracting video audio…' });
    }
    signal.throwIfAborted();
    if (!decoded) throw Error('The video’s audio track is empty. Uncheck “Use video audio as song audio” to import poses only.');
    return { file: new File([wave.bytes], `${file.name.replace(/\.[^.]+$/, '')}.wav`, { type: 'audio/wav' }), durationMs: Math.round(wave.frames * 1000 / wave.sampleRate) };
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener('abort', abort); input.dispose();
  }
}

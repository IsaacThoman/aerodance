// What the native host (src/Host.mm) puts on globalThis.__native before the runtime runs.

/** Sync queries: they run after every command sent so far (see Native.query). */
export const Q = {
  getParameter: 1, getError: 2, shaderParameter: 3, shaderInfoLog: 4, programInfo: 5, readPixels: 6,
  getBufferSubData: 7, getImageData: 8, checkFramebufferStatus: 9, isEnabled: 10, finish: 11,
  internalformatParameter: 12, texParameter: 13, glInfo: 14, frameStats: 15, shaderSource: 16, toBlob: 17,
} as const;

export interface Native {
  /** 0: every command runs as soon as it is encoded, on this thread (one native call per GL call).
   *  1: commands run when a frame ends or a query needs them, on this thread.
   *  2: commands run on a render thread, a frame behind (pipelined). */
  readonly mode: number;
  /** The command buffers; the host owns their memory. */
  readonly buffers: ArrayBuffer[];
  /** Hands words [0, n) of the current buffer to the executor and returns the next buffer's index. */
  submit(words: number, endOfFrame: boolean): number;
  /** Copies a large payload into native memory; commands reference it by the returned handle. */
  block(bytes: ArrayBufferView): number;
  /** Interns a string for a command (shader source, canvas text); freed after use. */
  str(text: string): number;
  /** Runs a query after the commands so far. readPixels / getImageData / getBufferSubData write into `out`. */
  query(kind: number, a?: number, b?: number, c?: number, d?: number, e?: number, f?: number, out?: ArrayBufferView): unknown;
  /** A CSS font for measuring and drawing text; the same string always gets the same id. */
  font(css: string): number;
  /** Measures text in a font; writes width, actual bounding box (left, right, ascent, descent) and
   *  font ascent and descent into `metrics`. */
  measureText(font: number, text: string, letterSpacing: number, metrics: Float64Array): void;
  /** Decodes an image (bytes or a bundled path) off-thread; calls done(id, width, height) or done(0, 0, 0, message). */
  decodeImage(source: ArrayBufferView | string, done: (id: number, w: number, h: number, error?: string) => void): void;
  releaseImage(id: number): void;
  /** Reads a bundled file (path relative to the bundle's www/), or null. */
  readFile(path: string): ArrayBuffer | null;
  /** HTTP request off-thread; calls done(status, body, headersJson) or done(0, null, error). */
  http(method: string, url: string, body: string | ArrayBufferView | null, headersJson: string, done: (status: number, body: ArrayBuffer | null, headers: string) => void): void;
  /** Wakes the timer loop (globalThis.__host.timers) after ms. */
  wake(ms: number): void;
  now(): number;
  log(level: number, text: string): void;
  /** Append a diagnostic report to Library/Caches/aerodance-bench.ndjson. */
  report(json: string): void;
  /** Persistent key-value storage (localStorage). */
  storageGet(key: string): string | null;
  storageSet(key: string, value: string | null): void;
  storageKeys(): string;
  /** Files the page keeps, under Library/Caches/aerodance/ (paths relative to it): a file's bytes or null. */
  fileRead(path: string): ArrayBuffer | null;
  /** Writes a file whole, making its folders: '' when it did, else why ('full' when out of space). */
  fileWrite(path: string, bytes: ArrayBufferView): string;
  /** A folder's entries as JSON [{ name, size, dir }]. */
  fileList(path: string): string;
  /** Removes a file, or a folder and everything in it. */
  fileRemove(path: string): void;
  /** Moves a file or folder in place of whatever is at `to`: '' when it did, else why. */
  fileMove(from: string, to: string): string;
  /** SHA digests via CommonCrypto: algorithm 1, 256, 384 or 512. */
  digest(algorithm: number, data: ArrayBufferView): ArrayBuffer;
  randomBytes(out: ArrayBufferView): void;
  /** Tells the host the page is on its top-level menu (the Menu button then leaves the app). */
  setAtRoot(atRoot: boolean): void;
  /** Tells the host the page is showing its first screen (the splash then fades out). */
  ready(): void;
  /** Launch configuration as JSON. */
  readonly config: string;
  /** Web Audio (src/Audio.mm). */
  audio(command: number, ...args: unknown[]): unknown;
  /** WebSocket and EventSource (src/Net.mm, runtime/net.ts). */
  net(command: number, ...args: unknown[]): unknown;
}

export const native = (globalThis as unknown as { __native: Native }).__native;

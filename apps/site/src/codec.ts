// Each of the page's videos comes in two encodings: AV1, about half the size, and H.264, which
// every browser plays. index.html lists both for each video, AV1 first and each typed with its
// codecs, so that without this script a browser plays the first it can. With it, the page chooses
// once, here, for all its videos, and each is given its one source in that encoding before any of
// it loads: until then index.html has them all preload nothing.
//
// AV1 is chosen where the browser says it plays the hardest of the files smoothly, and on a phone
// or a tablet (a screen without hover) power-efficiently too, that is with a hardware decoder: in
// software, 1280x960 at 60 frames a second can stutter on a slow phone, and it runs the battery
// down. Anywhere else it's H.264, as it is where the browser can't say (no MediaCapabilities).
// Safari on a device without an AV1 decoder says it's not supported.

/** The hardest of the AV1 files, stages/falls-av1.mp4, as MediaCapabilities takes it: its codecs as the file gives them, its size, frame rate and bitrate. */
const HARDEST: VideoConfiguration = { contentType: 'video/mp4; codecs="av01.0.09M.08"', width: 1280, height: 960, framerate: 60, bitrate: 6_740_000 };

let choice: Promise<boolean> | undefined;

/** Whether the page plays its videos' AV1 encodings: asked once. */
export const playsAv1 = () => (choice ??= (async () => {
  try {
    const info = await navigator.mediaCapabilities.decodingInfo({ type: 'file', video: HARDEST });
    return info.supported && info.smooth && (info.powerEfficient || !matchMedia('(hover: none)').matches);
  } catch {
    // No MediaCapabilities, or it couldn't say.
    return false;
  }
})());

/**
 * Gives `video` the source the browser would take from its <source>s if they were only the page's
 * encoding (the first whose media query matches), as its src, and takes the <source>s away.
 * Setting src loads nothing while the video's preload is "none"; calling load() would, as Chrome
 * takes that as asking for the video. Until this resolves, nothing may load or play the video.
 */
export async function chooseSource(video: HTMLVideoElement) {
  const av1 = await playsAv1();
  const sources = [...video.querySelectorAll('source')];
  const source = sources.find((s) => s.type.includes('av01') === av1 && (!s.media || matchMedia(s.media).matches));
  for (const s of sources) s.remove();
  if (source) video.src = source.src;
}

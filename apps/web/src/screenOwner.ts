/**
 * Who draws the frame. A dance stage (stage/StageView.tsx) sets `stage` while it holds the
 * renderer's settings, and the Aero world (aero/AeroWorld.tsx) stands down for exactly that long.
 *
 * A plain flag rather than React state: the stage lives in the canvas's React root and the app
 * in the page's, so state passed between them lands frames apart, and every frame the world drew
 * with the stage's settings (shadows, tone mapping) recompiled its shaders.
 */
export const screenOwner = { stage: false };

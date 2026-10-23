/*
 * What the iPhone/iPad app (apps/ios/) tells the page about itself. Browsers don't set it,
 * so everything reads as false there.
 *
 *   globalThis.__aerodanceHost = { interrupted, tv, screen, held, screens }
 *   window 'aerodance-host' event (a CustomEvent, detail = the same fields) on every change
 *
 * interrupted: a phone call, Siri or an alarm has taken the app's audio.
 * tv:          the game is on an external display (AirPlay Screen Mirroring or an HDMI
 *              adapter) and its sound goes there too, which delays its picture along with
 *              its sound.
 * screen:      where the game's picture is: 'phone' (the iPhone or iPad itself) or 'tv' (an
 *              external display, wherever the sound goes).
 * held:        which way up the iPhone or iPad is held, in window.orientation's terms: 0 upright,
 *              90 turned counterclockwise (sideways, its bottom on the right), -90 clockwise, 180
 *              upside down. Lying flat, it's the way it was last held. (Kept up to date while the
 *              game is on a TV.)
 * screens:     { game, phone, latest }: which way up the game's screen (a TV's is always upright)
 *              and the phone's own screen are, in the same terms, and which of the two last
 *              turned. With held, these turn the camera's picture upright: cameraTurn().
 *
 * The app also lays an invisible AirPlay picker over the game's AirPlay bubble
 * (menu/AirPlayButton.tsx), where the page says it is: placeAirPlayPicker().
 *
 * const off = onHostChange((host) => ...); hostState().tv; inApp(); client() === 'tvos'
 */

/** Which way up something is, in window.orientation's terms (held, above). */
export type Orientation = 0 | 90 | -90 | 180;
export interface HostState {
  interrupted: boolean; tv: boolean; screen: 'phone' | 'tv';
  held: Orientation; screens: { game: Orientation; phone: Orientation; latest: 'game' | 'phone' };
}

const record = (value: unknown) => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
const orientation = (value: unknown): Orientation => value === 90 || value === -90 || value === 180 ? value : 0;
const read = (value: unknown): HostState => {
  const v = record(value), screens = record(v.screens);
  return { interrupted: v.interrupted === true, tv: v.tv === true, screen: v.screen === 'tv' ? 'tv' : 'phone',
    held: orientation(v.held), screens: { game: orientation(screens.game), phone: orientation(screens.phone),
      latest: screens.latest === 'phone' ? 'phone' : 'game' } };
};
const host = () => (globalThis as { __aerodanceHost?: unknown }).__aerodanceHost;

export const hostState = () => read(host());

/** The page runs in the iPhone/iPad app rather than a browser. */
export const inApp = () => typeof host() === 'object' && host() !== null;

/**
 * Which build of the game this is: 'web' (a browser), 'ios' (the iPhone/iPad app's web view,
 * apps/ios/) or 'tvos' (the Apple TV app's JavaScriptCore host, apps/tvos/, which puts its
 * natives on globalThis.__native). Prefer checking for the feature itself where there is one
 * (RTCPeerConnection, getUserMedia); this is for what only the platform tells you.
 */
export type Client = 'web' | 'ios' | 'tvos';
export const client = (): Client => ('__native' in globalThis ? 'tvos' : inApp() ? 'ios' : 'web');

/** Calls fn with the app's new state on every change; returns the unsubscribe. */
export function onHostChange(fn: (state: HostState) => void, target: EventTarget | undefined = globalThis.window) {
  const listener = (e: Event) => fn(read((e as CustomEvent<unknown>).detail));
  target?.addEventListener('aerodance-host', listener);
  return () => target?.removeEventListener('aerodance-host', listener);
}

/** A camera picture's size, and which way its camera faces (MediaTrackSettings.facingMode). */
export interface CameraFrame { width: number; height: number; facing?: string; }

/**
 * How far to turn the app's camera picture while the game is on a TV, clockwise in degrees (0,
 * 90, 180 or 270), so that it's upright the way the device is held. WebKit turns it upright for
 * the screen instead, and a TV's screen stays upright however the phone is turned. It keeps one
 * camera orientation for the whole app, from whichever web view's screen last turned, so on an
 * iPad the remote, on the iPad's screen, can set it too: a picture taller than it's wide is
 * upright for an upright screen and a wider one for a sideways screen, which tells the game's
 * screen and the iPad's apart, and the one that turned last wins a tie (upright and upside down).
 * The front camera faces the other way from the back one, so its picture turns the other way
 * round. Cameras that are neither (one plugged into an iPad) don't turn with it. With the game on
 * the phone, the picture is left as WebKit turns it, upright for the screen the player sees.
 */
export function cameraTurn({ width, height, facing }: CameraFrame, host = hostState()) {
  if (host.screen !== 'tv' || (facing !== 'user' && facing !== 'environment')) return 0;
  const { game, phone, latest } = host.screens, upright = height > width;
  const screens = latest === 'phone' ? [phone, game] : [game, phone];
  const screen = screens.find((o) => (o % 180 === 0) === upright) ?? game;
  const turn = facing === 'user' ? host.held - screen : screen - host.held;
  return (turn % 360 + 360) % 360;
}

/** Where the app's AirPlay picker goes, in the page's CSS pixels; null takes it away. */
export interface PickerRect { x: number; y: number; w: number; h: number; }
type AirPlayHook = (rect: PickerRect | null) => void;
const airPlayHook = () => (globalThis as { __aerodanceAirPlayAt?: unknown }).__aerodanceAirPlayAt;

/** The app can lay an AirPlay picker over the page (the iPhone/iPad app, not a browser). */
export const canPickAirPlay = () => typeof airPlayHook() === 'function';

/** Puts the app's invisible AirPlay picker over this rect, or takes it away. */
export function placeAirPlayPicker(rect: PickerRect | null) {
  const hook = airPlayHook();
  if (typeof hook === 'function') (hook as AirPlayHook)(rect);
}

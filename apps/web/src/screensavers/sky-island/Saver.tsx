import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useDisposable } from '../../../../../packages/stages/shared/hooks.ts';
import type { PostOverrides } from '../../../../../packages/stages/shared/post.tsx';
import { SaverWorld, clockHands, dolly, orbit, placeCamera, shiftPicture } from '../kit.ts';
import type { Shot } from '../kit.ts';
import type { ScreensaverContext } from '../types.ts';
import { atmosphere, discBasis, sceneSky, starRotation } from './atmosphere.ts';
import type { Atmosphere, RGB } from './atmosphere.ts';
import { Enamel, Glass, ClockFaces, Rotors, CLOCK, ROTOR, towerBase } from './Buildings.tsx';
import { Lightning, WeatherEase } from './ease.ts';
import { Land, Mist, Pond, Water } from './Island.tsx';
import { FALLS_ANGLE, GREENHOUSE, LIP, SEA_Y, TIP_Y, TOWER, TREES, TURBINES, groundHeight, rimRadius, treeCanopy, undersideProfile } from './layout.ts';
import { Fireflies, Trees } from './Life.tsx';
import { BOLT, Bolt, CLOUD_COVER, CLOUD_SPIN, CloudSea, Cumulus, FLARE, SkyDome, SunFlare } from './Sky.tsx';
import { FALL, RAIN_BOX, Rain, SNOW_BOX, Snow } from './Weather.tsx';
import { MAX_CASTERS, W, makeNoiseTexture } from './world.ts';

/*
 * Sky Island: a grassy island floating over a sea of clouds, lit by the real sky. The sun and the
 * moon stand as high as they really do where the device is (atmosphere.ts draws their bearings
 * out so sunrise and sunset happen in view), the moon in its real phase, the stars turning; the
 * weather is the real weather (or the one chosen), eased in: cloud, rain on the pond, snow lying,
 * fog, a thunderstorm's lightning, the wind in the trees and the turbines. Its clock tower tells
 * the island's time, or, with the Clock setting on In scene, the real time.
 */

const POST: PostOverrides = { bloomStrength: 0.36, bloomRadius: 0.5, bloomThreshold: 2.0, vignette: 0.16, saturation: 1.1 };

const fallsOut: [number, number] = [Math.cos(FALLS_ANGLE), Math.sin(FALLS_ANGLE)];
const clockY = towerBase() - 0.15 + TOWER.clockY;

/** The views: each a slow move that looks good for a minute or more. */
export const VIEWS: Readonly<Record<string, Shot>> = {
  // The whole island hanging in the sky, the falls pouring off its front.
  island: dolly([-13, 11, 84], [11, 15, 79], [0, -1.5, 0], { toTarget: [1, 0.5, 0], seconds: 90, fov: 40 }),
  // Slowly round it.
  orbit: orbit([0, -5, 0], 66, 13, { seconds: -240, start: 0.25, fov: 40, bob: 1.5 }),
  // In the garden, by the pond, the greenhouse on the left and the clock tower ahead.
  garden: dolly([-4.5, 4.2, 27], [6.5, 5.4, 25.5], [2.5, clockY - 4.2, -6], { toTarget: [6, clockY - 3.6, -7], seconds: 75, fov: 42 }),
  // Low down by the sea of clouds, looking up at the falls and the island's underside.
  falls: dolly(
    [LIP[0] + fallsOut[0] * 52 - fallsOut[1] * 26, SEA_Y + 16, LIP[1] + fallsOut[1] * 52 + fallsOut[0] * 26],
    [LIP[0] + fallsOut[0] * 46 + fallsOut[1] * 8, SEA_Y + 20, LIP[1] + fallsOut[1] * 46 - fallsOut[0] * 8],
    [LIP[0] * 0.55, -24, LIP[1] * 0.55], { toTarget: [LIP[0] * 0.5, -20, LIP[1] * 0.5], seconds: 85, fov: 46 },
  ),
};

// The shadow casters: trees' canopies, the greenhouse (glass: lighter), the tower and its clock, the turbines.
function setCasters() {
  const casters = W.uCasters.value, tops = W.uCasterTops.value;
  let i = 0;
  const add = (x: number, y0: number, z: number, r: number, y1: number, strength: number) => {
    if (i >= MAX_CASTERS) return;
    casters[i].set(x, y0, z, r);
    tops[i].set(y1, strength);
    i++;
  };
  for (const [x, z, s] of TREES) { const c = treeCanopy(s), g = groundHeight(x, z); add(x, g + c.y, z, c.r, g + c.y, 0.85); }
  add(GREENHOUSE.x, groundHeight(GREENHOUSE.x, GREENHOUSE.z), GREENHOUSE.z, GREENHOUSE.r, groundHeight(GREENHOUSE.x, GREENHOUSE.z), 0.4);
  const tb = towerBase();
  add(TOWER.x, tb, TOWER.z, 1.7, tb + 10, 1);
  add(TOWER.x, tb + TOWER.clockY - 1.2, TOWER.z, TOWER.half * 1.15, tb + TOWER.clockY + 1.6, 1);
  for (const { x, z, s } of TURBINES) { const g = groundHeight(x, z); add(x, g, z, 0.5 * s, g + 13 * s, 0.9); }
  for (; i < MAX_CASTERS; i++) casters[i].set(0, -1000, 0, 0);
}

// Whether the island hides the sun from `from` along `dir` (for the flare): marching through a rough model of it.
function islandHides(from: THREE.Vector3, dir: THREE.Vector3): boolean {
  for (let t = 1; t < 160; t += 0.75) {
    const x = from.x + dir.x * t, y = from.y + dir.y * t, z = from.z + dir.z * t;
    if (y > 4) { if (dir.y >= 0) return false; continue; }
    if (y < TIP_Y) { if (dir.y <= 0) return false; continue; }
    const a = Math.atan2(z, x), R = rimRadius(a), r = Math.hypot(x, z);
    if (r >= R * 1.01) continue;
    if (y > -1.6) { if (y < groundHeight(x, z)) return true; continue; }
    const depth = Math.pow(Math.min(1, (-1.6 - y) / (Math.abs(TIP_Y) - 1.6)), 1 / 1.25);
    if (r < R * undersideProfile(depth, a).radius) return true;
  }
  return false;
}

const setColor = (u: { value: THREE.Color }, c: RGB) => u.value.setRGB(c[0], c[1], c[2]);

function Driver({ ctx }: { ctx: ScreensaverContext }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const noise = useDisposable(makeNoiseTexture);
  W.uNoise.value = noise;
  const boltRef = useRef<THREE.Mesh>(null);
  const run = useMemo(() => {
    setCasters();
    return {
      ease: new WeatherEase(),
      lightning: new Lightning(13),
      sun: new THREE.Vector3(), moon: new THREE.Vector3(), moonSun: new THREE.Vector3(),
      sunTo: new THREE.Vector3(), moonTo: new THREE.Vector3(), moonSunTo: new THREE.Vector3(),
      key: new THREE.Vector3(), v: new THREE.Vector3(), forward: new THREE.Vector3(),
      first: true, skyAt: 0, sunEl: 0, moonEl: 0, atm: null as Atmosphere | null,
      frames: 0, readyAt: 3, strikes: 0, flareVis: 0, reportAt: 0,
    };
  }, []);

  useFrame((_state, delta) => {
    const dt = Math.min(Math.max(delta, 0), 0.1);
    const s = run, t = ctx.time();
    const sky = ctx.sky();
    s.ease.step(sky.weather, dt);
    const e = s.ease;

    // The sun and the moon, eased (a change of Time setting sweeps them across rather than jumping),
    // towards where the sky says, and the light from them. (Worked out twenty times a second: it
    // allocates, and the Apple TV runs this without a JIT. The eased directions move every frame.)
    if (s.first || t >= s.skyAt) {
      s.skyAt = t + 0.05;
      const dirs = sceneSky(sky);
      s.sunTo.set(...dirs.sun);
      s.moonTo.set(...dirs.moon);
      s.moonSunTo.set(...dirs.moonSun);
      if (s.first) { s.sun.copy(s.sunTo); s.moon.copy(s.moonTo); s.moonSun.copy(s.moonSunTo); }
      const sunEl = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(s.sun.y, -1, 1)));
      const moonEl = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(s.moon.y, -1, 1)));
      s.sunEl = sunEl;
      s.moonEl = moonEl;
      const atm = atmosphere({ sun: sunEl, moon: moonEl, moonLit: sky.moon.lit, clouds: e.clouds, rain: e.rain, snow: e.snow, fog: e.fog, storm: e.storm });
      s.atm = atm;
      setColor(W.uKeyColor, atm.key);
      setColor(W.uSunColor, atm.sunColor);
      setColor(W.uZenith, atm.zenith);
      setColor(W.uHorizon, atm.horizon);
      setColor(W.uBelow, atm.below);
      setColor(W.uGlow, atm.glow);
      setColor(W.uAmbSky, atm.ambSky);
      setColor(W.uAmbGround, atm.ambGround);
      setColor(W.uCloudLit, atm.cloudLit);
      setColor(W.uCloudShade, atm.cloudShade);
      setColor(W.uFogColor, atm.fogColor);
      W.uGlowAmount.value = atm.glowAmount;
      W.uFogDensity.value = atm.fogDensity;
      W.uSunDisc.value = atm.sunDisc;
      W.uStars.value = atm.stars;
      W.uMoonVis.value = atm.moonVis;
      W.uDaylight.value = atm.daylight;
      W.uNight.value = atm.night;
      W.uLamps.value = atm.lamps;
      W.uFireflies.value = atm.fireflies;
      W.uOvercast.value = atm.overcast;
      const stars = starRotation(sky.date, sky.place.lat);
      W.uStarAxis.value.set(...stars.axis);
      W.uStarAngle.value = stars.angle;
      const basis = discBasis([s.moon.x, s.moon.y, s.moon.z]);
      W.uMoonR.value.set(...basis.right);
      W.uMoonU.value.set(...basis.up);
    }
    s.first = false;
    const k = 1 - Math.exp(-dt * 1.6);
    s.sun.lerp(s.sunTo, k).normalize();
    s.moon.lerp(s.moonTo, k).normalize();
    s.moonSun.lerp(s.moonSunTo, k).normalize();
    const atm = s.atm!;
    W.uTime.value = t;
    W.uSunDir.value.copy(s.sun);
    W.uMoonDir.value.copy(s.moon);
    W.uMoonSun.value.copy(s.moonSun);
    // The light comes from the sun, or the moon, or (in twilight) between them, never from below.
    s.key.copy(s.sun).lerp(s.moon, atm.moonShare);
    if (s.key.y < 0.06) s.key.y = 0.06;
    W.uKeyDir.value.copy(s.key.normalize());
    W.uFog.value = e.fog;
    W.uCloud.value = e.clouds;
    W.uRain.value = e.rain;
    W.uSnowFall.value = e.snow;
    W.uSnowCover.value = e.snowCover;
    W.uWet.value = e.wet;
    W.uStorm.value = e.storm;
    const sunEl = s.sunEl, moonEl = s.moonEl;

    // The wind: the trees' sway, the turbines, the clouds and the sea of clouds drifting.
    const wind = e.wind;
    W.uWind.value = wind;
    // Each wraps where everything reading it lines up again (sines at whole turns, textures at whole tiles).
    // The sway: sines of it and of 2.3 times it.
    W.uSway.value = (W.uSway.value + dt * (0.6 + 2.2 * wind)) % (Math.PI * 20);
    W.uGust.value = (W.uGust.value + dt * (0.03 + 0.1 * wind)) % 1;
    W.uFlow.value.set((W.uFlow.value.x + dt * 0.05) % 1, (W.uFlow.value.y + dt * 0.62) % 1);
    const wd = W.uWindDir.value;
    // The high clouds sample at 0.55, 1.5 and 3.9 times: 20 lines them all up.
    W.uDrift.value.set((W.uDrift.value.x + wd.x * dt * (0.002 + 0.012 * wind)) % 20, (W.uDrift.value.y + wd.y * dt * (0.002 + 0.012 * wind)) % 20);
    // The sea's pattern repeats every 250 units (its octaves at whole multiples).
    W.uSeaDrift.value.set((W.uSeaDrift.value.x + wd.x * dt * (1.2 + 5 * wind)) % 250, (W.uSeaDrift.value.y + wd.y * dt * (1.2 + 5 * wind)) % 250);
    CLOUD_SPIN.value = (CLOUD_SPIN.value + dt * (0.0012 + 0.005 * wind)) % (Math.PI * 2);
    CLOUD_COVER.value = 0.42 + e.clouds * 0.7;
    // (The rotors turn at whole eighths of this: 16 pi lines them up.)
    ROTOR.value = (ROTOR.value + dt * (0.35 + 3.2 * wind)) % (Math.PI * 16);
    // Rain and snow, carried down and along (wrapped in their boxes).
    FALL.rain.set((FALL.rain.x + wd.x * wind * 7 * dt) % RAIN_BOX.x, (FALL.rain.y - 24 * dt) % RAIN_BOX.y, (FALL.rain.z + wd.y * wind * 7 * dt) % RAIN_BOX.z);
    FALL.snow.set((FALL.snow.x + wd.x * (0.4 + wind * 3) * dt) % SNOW_BOX.x, (FALL.snow.y - 1.5 * dt) % SNOW_BOX.y, (FALL.snow.z + wd.y * (0.4 + wind * 3) * dt) % SNOW_BOX.z);

    // The camera, through the view showing; pushed right while the preview covers the left.
    const view = ctx.view();
    const shot = VIEWS[view] ?? VIEWS.island;
    placeCamera(camera, shot(ctx.viewTime()), camera.fov);
    shiftPicture(camera, ctx.shift());
    camera.updateMatrixWorld();

    // Lightning: a flash lighting everything, and a bolt somewhere ahead.
    s.lightning.step(dt, e.storm);
    W.uFlash.value = s.lightning.flash;
    BOLT.value = s.lightning.bolt();
    const bolt = boltRef.current;
    if (bolt) {
      if (s.lightning.strikes !== s.strikes) {
        s.strikes = s.lightning.strikes;
        camera.getWorldDirection(s.forward);
        const yaw = Math.atan2(s.forward.x, s.forward.z) + s.lightning.across * 0.55;
        const dist = 420 + s.lightning.far * 420;
        bolt.position.set(camera.position.x + Math.sin(yaw) * dist, SEA_Y - 5, camera.position.z + Math.cos(yaw) * dist);
        bolt.rotation.set(0, Math.atan2(camera.position.x - bolt.position.x, camera.position.z - bolt.position.z), 0);
        const h = 240 + s.lightning.shape * 70;
        bolt.scale.set(h * (s.lightning.shape > 0.5 ? 1 : -1), h, 1);
      }
      bolt.visible = BOLT.value > 0.002;
    }

    // The sun's flare: on screen, not behind the island, and not clouded over (eased).
    s.v.copy(s.sun).multiplyScalar(500).add(camera.position).project(camera);
    const onScreen = s.v.z < 1 ? THREE.MathUtils.clamp((1.2 - Math.max(Math.abs(s.v.x), Math.abs(s.v.y))) / 0.4, 0, 1) : 0;
    const hidden = onScreen > 0 && islandHides(camera.position, s.sun);
    const want = hidden ? 0 : onScreen * atm.sunDisc * THREE.MathUtils.smoothstep(sunEl, -1, 2);
    s.flareVis += (want - s.flareVis) * (1 - Math.exp(-dt * 6));
    FLARE.sun.set(s.v.x, s.v.y);
    FLARE.vis.value = s.flareVis;
    FLARE.aspect.value = camera.aspect;

    // The clock tower: the island's time, or the real time when the clock is in the scene.
    const inScene = ctx.clock() === 'scene';
    const hands = clockHands(inScene ? new Date() : sky.date);
    CLOCK.hands.set(hands.hour, hands.minute, hands.second);
    CLOCK.second.value = inScene ? 1 : 0;
    CLOCK.light.value = Math.max(atm.lamps, inScene ? 0.35 : 0);

    if (t >= s.reportAt) {
      s.reportAt = t + 0.5;
      ctx.report({ islandSun: Math.round(sunEl * 10) / 10, islandMoon: Math.round(moonEl * 10) / 10, islandCloud: Math.round(e.clouds * 100) / 100, islandSnow: Math.round(e.snowCover * 100) / 100, islandWet: Math.round(e.wet * 100) / 100, islandFog: Math.round(e.fog * 100) / 100, islandStorm: Math.round(e.storm * 100) / 100, islandClock: inScene ? 'real' : 'island' });
    }
    if (++s.frames === s.readyAt) ctx.ready();
  });
  return <Bolt boltRef={boltRef} />;
}

export default function SkyIslandSaver({ ctx }: { ctx: ScreensaverContext }) {
  return (
    <SaverWorld camera={{ position: [0, 15, 76], target: [0, -5, 0], fov: 38, near: 0.5, far: 9000 }} background="#000000" environment={false} post={POST}>
      <Driver ctx={ctx} />
      <SkyDome />
      <CloudSea />
      <Cumulus />
      <Land />
      <Pond />
      <Enamel />
      <Rotors />
      <Trees />
      <ClockFaces />
      <Water />
      <Glass />
      <Mist />
      <Fireflies />
      <Rain />
      <Snow />
      <SunFlare />
    </SaverWorld>
  );
}

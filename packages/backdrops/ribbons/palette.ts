import * as THREE from 'three';

// Vista-era sky and light colours (sRGB hex; THREE.Color converts to linear).
export const SKY = {
  zenith: '#0349ad',
  upper: '#0d7ad9',
  middle: '#2a9cea',
  low: '#62c2f2',
  floor: '#a6e6fb',
  glow: '#e6fcff',
};

export const RIBBON = {
  lime: '#7fe81c',
  green: '#1fc548',
  white: '#effff2',
  cyan: '#18c6f2',
  aqua: '#12c8ae',
  sky: '#8fd3ff',
  deep: '#0e8fd6',
};

// Where the light the ribbons sweep through sits, in view-plane units (x right, y up; the
// 16:9 frame spans about ±0.68 by ±0.38, 4:3 about ±0.68 by ±0.51): high on the right, clear
// of the title on the left and the dancers below.
export const LIGHT = new THREE.Vector2(0.4, 0.25);

// Uniforms shared by every material in the scene, updated once a frame.
export const world = {
  uTime: { value: 0 },
};

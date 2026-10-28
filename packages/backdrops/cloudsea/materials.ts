import * as THREE from 'three';
import { shaderMaterial } from '../../stages/shared/glsl.ts';
import { atmos } from './palette.ts';
import { atmosGLSL } from './shaders.ts';

// Materials for the things that fly: glossy enamel and clear glass, lit by the same sunrise as
// the clouds (shaders.ts) and hazed by the same air. Both work on plain and instanced meshes.

const vertexShader = /* glsl */ `
  attribute vec4 aColor;
  varying vec4 vColor;
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main() {
    mat4 m = modelMatrix;
    #ifdef USE_INSTANCING
      m = m * instanceMatrix;
    #endif
    vec4 w = m * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(m) * normal);
    vColor = aColor;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

/**
 * Glossy enamel coloured per vertex by `aColor`: rgb is the (linear) albedo, a the gloss from 0
 * to 1; a negative a makes the vertex glow instead, -a times its colour.
 */
export function glossMaterial(haze = 0.8) {
  return shaderMaterial({
    uniforms: { ...atmos, uHaze: { value: haze } },
    vertexShader,
    fragmentShader: /* glsl */ `
      uniform float uHaze;
      varying vec4 vColor;
      varying vec3 vWorld;
      varying vec3 vNormal;
      ${atmosGLSL}
      void main() {
        vec3 toCam = cameraPosition - vWorld;
        float dist = length(toCam);
        vec3 v = toCam / dist;
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        vec3 col = vColor.a < 0.0 ? vColor.rgb * -vColor.a : glossShade(vColor.rgb, vColor.a, n, v);
        col = mix(col, hazeColor(-v), fogAmount(dist) * uHaze);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

/** Clear glass (the pods' domes): a fresnel reflection of the sky and a sun glint over a faint aqua tint. */
export function glassMaterial(haze = 0.8) {
  return shaderMaterial({
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: { ...atmos, uHaze: { value: haze } },
    vertexShader,
    fragmentShader: /* glsl */ `
      uniform float uHaze;
      varying vec4 vColor;
      varying vec3 vWorld;
      varying vec3 vNormal;
      ${atmosGLSL}
      void main() {
        vec3 toCam = cameraPosition - vWorld;
        float dist = length(toCam);
        vec3 v = toCam / dist;
        vec3 n = normalize(vNormal);
        float nv = abs(dot(n, v));
        float fres = 0.05 + 0.95 * pow(1.0 - nv, 4.0);
        vec3 col = envColor(reflect(-v, n)) * fres;
        vec3 h = normalize(uSunDir + v);
        float glint = pow(max(dot(n, h), 0.0), 220.0) * 8.0 + pow(max(dot(n, h), 0.0), 24.0) * 0.25;
        col += uSunCol * glint + vColor.rgb * 0.12;
        float a = clamp(fres * 0.85 + 0.1 + glint * 0.2, 0.0, 1.0);
        float fog = fogAmount(dist) * uHaze;
        col = mix(col, hazeColor(-v) * a, fog);
        gl_FragColor = vec4(col, a);
      }
    `,
  });
}

// Microbenchmarks of the JavaScriptCore host's bridge costs on the device: a plain JavaScript
// call, a native (JSC C API) call, and the WebGL shim's encoding of the calls three.js makes
// most. Reports go out like the Aero benchmark's (apps/tvos/bench/README.md), as type "bridge".
type Host = typeof globalThis & {
  __native: { noop(): void; noop4(a: number, b: number, c: number, d: number): void; mode: number };
  __benchReport?: (json: string) => void;
};
const host = globalThis as Host;
const N = 50_000;

function time(label: string, fn: (n: number) => void, results: Record<string, number>) {
  fn(1000);  // warm up
  const t = performance.now();
  fn(N);
  // Nanoseconds per call.
  results[label] = Math.round(((performance.now() - t) * 1e6) / N);
}

function main() {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const gl = canvas.getContext('webgl2') as WebGL2RenderingContext;
  const vs = gl.createShader(gl.VERTEX_SHADER) as WebGLShader;
  gl.shaderSource(vs, '#version 300 es\nuniform mat4 m; uniform mat3 n; uniform float f; in vec4 p; void main() { gl_Position = m * p * f + vec4(n[0], 0.0); }');
  gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER) as WebGLShader;
  gl.shaderSource(fs, '#version 300 es\nprecision highp float; out vec4 c; void main() { c = vec4(1.0); }');
  gl.compileShader(fs);
  const prog = gl.createProgram() as WebGLProgram;
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  gl.useProgram(prog);
  const m = gl.getUniformLocation(prog, 'm'), n3 = gl.getUniformLocation(prog, 'n'), f = gl.getUniformLocation(prog, 'f');
  const tex = gl.createTexture();
  const m16 = new Float32Array(16), m9 = new Float32Array(9);
  const scratch = new Float32Array(1024);
  const obj = { noop(_a: number, _b: number) {} };
  const nat = host.__native;
  const results: Record<string, number> = {};

  time('emptyLoop', (k) => { for (let i = 0; i < k; i++) { /* empty */ } }, results);
  time('jsCall', (k) => { for (let i = 0; i < k; i++) obj.noop(i, 1); }, results);
  time('nativeCall0', (k) => { for (let i = 0; i < k; i++) nat.noop(); }, results);
  time('nativeCall4', (k) => { for (let i = 0; i < k; i++) nat.noop4(i, 1, 2, 3); }, results);
  time('f32set16', (k) => { for (let i = 0; i < k; i++) scratch.set(m16, 8); }, results);
  time('f32loop16', (k) => { for (let i = 0; i < k; i++) { for (let j = 0; j < 16; j++) scratch[8 + j] = m16[j]; } }, results);
  time('uniform1f', (k) => { for (let i = 0; i < k; i++) gl.uniform1f(f, i); }, results);
  time('uniformMatrix4fv', (k) => { for (let i = 0; i < k; i++) gl.uniformMatrix4fv(m, false, m16); }, results);
  time('uniformMatrix3fv', (k) => { for (let i = 0; i < k; i++) gl.uniformMatrix3fv(n3, false, m9); }, results);
  time('bindTexture', (k) => { for (let i = 0; i < k; i++) gl.bindTexture(gl.TEXTURE_2D, tex); }, results);
  time('drawElements', (k) => { for (let i = 0; i < k; i++) gl.drawElements(gl.TRIANGLES, 0, gl.UNSIGNED_SHORT, 0); }, results);
  const json = JSON.stringify({ type: 'bridge', label: `bridge-${['direct', 'batched', 'threaded'][nat.mode]}`, nsPerCall: results });
  console.log(`BENCH ${json}`);
  host.__benchReport?.(json);
  host.__benchReport?.(JSON.stringify({ type: 'done', label: 'bridge' }));
}

main();
